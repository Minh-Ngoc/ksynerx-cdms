import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { Queue } from 'bullmq';
import pg from 'pg';

const { Client } = pg;
const config = readConfig(process.env);
const namespace = `load:${config.runId}`;
const queue = new Queue('cdms-change', {
  connection: { host: config.redisHost, port: config.redisPort },
});
const database = new Client({
  host: config.databaseHost,
  port: config.databasePort,
  database: config.databaseName,
  user: config.databaseUser,
  password: config.databasePassword,
});

try {
  await database.connect();
  await assertHealthy(config.baseUrl);
  await assertQueueIdle(queue);

  const baselineAccepted = await enqueueBaseline(config, namespace);
  await waitForQueueDrain(queue, config.drainTimeoutMs);

  const queueBefore = await getQueueCounts(queue);
  const observation = observeQueue(queue);
  const summaryPath = resolve(`load-tests/results/${config.runId}.k6-summary.json`);
  await mkdir(resolve('load-tests/results'), { recursive: true });

  await runK6(config, summaryPath);
  const observedQueue = await observation.stop();
  const drain = await waitForQueueDrain(queue, config.drainTimeoutMs);
  const databaseProof = await verifyDatabase(database, namespace, config.uniqueChanges);
  const k6Summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const report = createReport({ config, namespace, baselineAccepted, queueBefore, observedQueue, drain, databaseProof, k6Summary });
  const reportPath = resolve(`load-tests/results/${config.runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify(report, null, 2));
  if (!report.proofPassed) process.exitCode = 1;
} finally {
  await Promise.allSettled([database.end(), queue.close()]);
}

function readConfig(environment) {
  const uniqueChanges = positiveInteger(environment.UNIQUE_CHANGES, 100, 'UNIQUE_CHANGES');
  const duplicateFactor = positiveInteger(environment.DUPLICATE_FACTOR, 20, 'DUPLICATE_FACTOR');

  return {
    baseUrl: (environment.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    runId: environment.LOAD_RUN_ID ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
    uniqueChanges,
    duplicateFactor,
    spikeVus: positiveInteger(environment.SPIKE_VUS, 100, 'SPIKE_VUS'),
    workerConcurrency: positiveInteger(environment.CHANGE_WORKER_CONCURRENCY, 10, 'CHANGE_WORKER_CONCURRENCY'),
    drainTimeoutMs: positiveInteger(environment.DRAIN_TIMEOUT_MS, 60_000, 'DRAIN_TIMEOUT_MS'),
    requireBacklog: readBoolean(environment.REQUIRE_BACKLOG, true, 'REQUIRE_BACKLOG'),
    redisHost: environment.REDIS_HOST ?? 'localhost',
    redisPort: positiveInteger(environment.REDIS_PORT, 6379, 'REDIS_PORT'),
    databaseHost: environment.DATABASE_HOST ?? 'localhost',
    databasePort: positiveInteger(environment.DATABASE_PORT, 5432, 'DATABASE_PORT'),
    databaseName: environment.DATABASE_NAME ?? 'cdms',
    databaseUser: environment.DATABASE_USER ?? 'cdms',
    databasePassword: environment.DATABASE_PASSWORD ?? 'cdms_demo_password',
  };
}

async function assertHealthy(baseUrl) {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error(`Health precheck failed with HTTP ${response.status}`);
}

async function assertQueueIdle(queue) {
  const counts = await getQueueCounts(queue);
  if (counts.waiting !== 0 || counts.active !== 0) {
    // Queue counts are global rather than product-scoped. Refusing to run while work is in flight
    // prevents this load proof from attributing another workload's backlog or drain to this run.
    throw new Error(
      `Change queue is not idle (waiting=${counts.waiting}, active=${counts.active}); refusing to mix this proof with unrelated work`,
    );
  }
}

async function enqueueBaseline(config, namespace) {
  const deliveries = Array.from({ length: config.uniqueChanges }, (_, index) => createPayload(namespace, index, 2));
  // Wait for these version-2 writes to commit before k6 starts. This establishes deterministic
  // duplicate/stale outcomes despite concurrent BullMQ workers: later v2 deliveries duplicate and
  // later v1 deliveries are stale instead of racing to become independent accepted history rows.
  const responses = await runWithConcurrency(deliveries, 10, async (delivery) => {
    const response = await fetch(`${config.baseUrl}/webhooks/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delivery),
    });

    if (response.status !== 202) {
      throw new Error(`Baseline webhook was not accepted: HTTP ${response.status} ${await response.text()}`);
    }

    return response.status;
  });

  return responses.length;
}

function createPayload(namespace, index, version) {
  return {
    productId: `${namespace}:product:${String(index).padStart(5, '0')}`,
    version,
    payload: {
      sku: `${namespace}-SKU-${String(index).padStart(5, '0')}`,
      name: `Load product ${index}`,
      price: '10.00',
      quantity: index,
    },
    observedAt: '2026-09-08T00:00:00.000Z',
  };
}

async function runK6(config, summaryPath) {
  const child = spawn('k6', ['run', '--summary-export', summaryPath, 'load-tests/spike.js'], {
    env: {
      ...process.env,
      BASE_URL: config.baseUrl,
      LOAD_RUN_ID: `load:${config.runId}`,
      UNIQUE_CHANGES: String(config.uniqueChanges),
      DUPLICATE_FACTOR: String(config.duplicateFactor),
      SPIKE_VUS: String(config.spikeVus),
    },
    stdio: 'inherit',
  });

  const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (exitCode !== 0) throw new Error(`k6 exited with code ${exitCode}`);
}

function observeQueue(queue) {
  const startedAt = Date.now();
  const samples = [];
  const timer = setInterval(async () => {
    try {
      samples.push({ atMs: Date.now() - startedAt, ...(await getQueueCounts(queue)) });
    } catch (error) {
      samples.push({ atMs: Date.now() - startedAt, error: String(error) });
    }
  }, 50);

  return {
    async stop() {
      clearInterval(timer);
      samples.push({ atMs: Date.now() - startedAt, ...(await getQueueCounts(queue)) });
      const validSamples = samples.filter((sample) => sample.error === undefined);
      return {
        sampleCount: validSamples.length,
        maxWaiting: Math.max(0, ...validSamples.map((sample) => sample.waiting)),
        maxActive: Math.max(0, ...validSamples.map((sample) => sample.active)),
        maxCompleted: Math.max(0, ...validSamples.map((sample) => sample.completed)),
        maxFailed: Math.max(0, ...validSamples.map((sample) => sample.failed)),
        samples,
      };
    },
  };
}

async function waitForQueueDrain(queue, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const counts = await getQueueCounts(queue);
    if (counts.waiting === 0 && counts.active === 0) {
      return { drained: true, durationMs: Date.now() - startedAt, finalCounts: counts };
    }
    await delay(100);
  }

  return { drained: false, durationMs: Date.now() - startedAt, finalCounts: await getQueueCounts(queue) };
}

async function getQueueCounts(queue) {
  const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  };
}

async function verifyDatabase(database, namespace, expectedUniqueChanges) {
  // Only the unique baseline version is expected to persist. The burst deliberately contains no
  // new logical change, so these namespace-scoped queries prove duplicate/stale delivery did not
  // create history, regress state, or bypass the atomic outbox write without touching other data.
  const productPrefix = `${namespace}:product:%`;
  const stateCount = numberValue(await database.query('SELECT count(*) AS count FROM product_state WHERE product_id LIKE $1', [productPrefix]));
  const changeCount = numberValue(await database.query('SELECT count(*) AS count FROM product_changes WHERE product_id LIKE $1', [productPrefix]));
  const outboxCount = numberValue(await database.query('SELECT count(*) AS count FROM outbox_events WHERE aggregate_id LIKE $1', [productPrefix]));
  const duplicatePairs = numberValue(
    await database.query(
      `SELECT count(*) AS count FROM (
        SELECT product_id, version FROM product_changes WHERE product_id LIKE $1 GROUP BY product_id, version HAVING count(*) > 1
      ) duplicates`,
      [productPrefix],
    ),
  );
  const staleRegressions = numberValue(
    await database.query('SELECT count(*) AS count FROM product_state WHERE product_id LIKE $1 AND version <> 2', [productPrefix]),
  );
  const unexpectedHistoryVersions = numberValue(
    await database.query('SELECT count(*) AS count FROM product_changes WHERE product_id LIKE $1 AND version <> 2', [productPrefix]),
  );
  const missingOutboxRows = numberValue(
    await database.query(
      `SELECT count(*) AS count
       FROM product_changes changes
       WHERE changes.product_id LIKE $1
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events events WHERE events.aggregate_id = changes.product_id
         )`,
      [productPrefix],
    ),
  );

  return {
    expectedUniqueChanges,
    productStateCount: stateCount,
    productChangesCount: changeCount,
    outboxCount,
    duplicatePairs,
    staleRegressions,
    unexpectedHistoryVersions,
    missingOutboxRows,
    passed:
      stateCount === expectedUniqueChanges &&
      changeCount === expectedUniqueChanges &&
      outboxCount === expectedUniqueChanges &&
      duplicatePairs === 0 &&
      staleRegressions === 0 &&
      unexpectedHistoryVersions === 0 &&
      missingOutboxRows === 0,
  };
}

function createReport({ config, namespace, baselineAccepted, queueBefore, observedQueue, drain, databaseProof, k6Summary }) {
  const metrics = k6Summary.metrics ?? {};
  const acceptedRequests = metricCount(metrics.accepted_requests);
  const unexpectedHttpFailures = metricCount(metrics.unexpected_http_failures);
  const k6Attempts = metricCount(metrics.webhook_attempts);
  const duplicateDeliveries = k6Attempts / 2;
  const staleDeliveries = k6Attempts / 2;
  const expectedK6Attempts = config.uniqueChanges * config.duplicateFactor * 2;
  // Queue active count is operational evidence only. The configured worker bound is supplied
  // explicitly because the harness cannot safely infer a remote worker's runtime configuration.
  const queueActiveWithinBound = observedQueue.maxActive <= config.workerConcurrency;

  return {
    runId: config.runId,
    namespace,
    developerMachineEvidence: true,
    semantics: 'HTTP 202 confirms BullMQ ingress acceptance only; PostgreSQL proves the business-level exactly-once effect.',
    configuration: {
      baseUrl: config.baseUrl,
      uniqueLogicalChanges: config.uniqueChanges,
      duplicateFactor: config.duplicateFactor,
      spikeVus: config.spikeVus,
      workerConcurrency: config.workerConcurrency,
      requireBacklog: config.requireBacklog,
    },
    deliveries: {
      baselineAccepted,
      k6Attempts,
      expectedK6Attempts,
      totalAttempts: baselineAccepted + k6Attempts,
      duplicateDeliveries,
      staleDeliveries,
      acceptedRequests,
      acceptedRequestRate: k6Attempts === 0 ? 0 : acceptedRequests / k6Attempts,
      unexpectedHttpFailures,
    },
    queue: {
      before: queueBefore,
      maxWaiting: observedQueue.maxWaiting,
      maxActive: observedQueue.maxActive,
      activeWithinConfiguredWorkerBound: queueActiveWithinBound,
      observedSamples: observedQueue.sampleCount,
      drain,
    },
    latencyMs: {
      p50: metricPercentile(metrics.accepted_ingress_latency, 'med'),
      p95: metricPercentile(metrics.accepted_ingress_latency, 'p(95)'),
      p99: metricPercentile(metrics.accepted_ingress_latency, 'p(99)'),
    },
    database: databaseProof,
    proofPassed:
      k6Attempts === expectedK6Attempts &&
      acceptedRequests === expectedK6Attempts &&
      unexpectedHttpFailures === 0 &&
      (!config.requireBacklog || observedQueue.maxWaiting > queueBefore.waiting) &&
      queueActiveWithinBound &&
      drain.drained &&
      databaseProof.passed,
  };
}

function metricCount(metric) {
  return metric?.count ?? metric?.values?.count ?? 0;
}

function metricPercentile(metric, percentile) {
  return metric?.[percentile] ?? metric?.values?.[percentile] ?? null;
}

function numberValue(result) {
  return Number(result.rows[0].count);
}

async function runWithConcurrency(values, concurrency, operation) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function positiveInteger(raw, fallback, name) {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readBoolean(raw, fallback, name) {
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

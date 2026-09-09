import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const acceptedRequests = new Counter('accepted_requests');
const unexpectedHttpFailures = new Counter('unexpected_http_failures');
const webhookAttempts = new Counter('webhook_attempts');
const acceptedIngressLatency = new Trend('accepted_ingress_latency');

const baseUrl = requiredText('BASE_URL');
const runId = requiredText('LOAD_RUN_ID');
const uniqueChanges = positiveInteger('UNIQUE_CHANGES', 100);
const duplicateFactor = positiveInteger('DUPLICATE_FACTOR', 20);
const spikeVus = positiveInteger('SPIKE_VUS', 100);
const phaseAttempts = createPhaseAttempts(uniqueChanges * duplicateFactor * 2);

export const options = {
  scenarios: createScenarios(phaseAttempts, spikeVus),
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const globalAttempt = phaseOffset(exec.scenario.name, phaseAttempts) + exec.scenario.iterationInTest;
  const delivery = createDelivery(globalAttempt, uniqueChanges, runId);
  const response = http.post(`${baseUrl}/webhooks/inventory`, JSON.stringify(delivery), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'inventory-webhook' },
  });

  webhookAttempts.add(1);
  const accepted = check(response, {
    'webhook accepted by BullMQ ingress': (result) => result.status === 202,
  });

  if (accepted) {
    acceptedRequests.add(1);
    // This measures only HTTP-to-BullMQ acceptance. Queue processing and PostgreSQL commit occur
    // asynchronously, so treating it as business-processing latency would hide queue backpressure.
    acceptedIngressLatency.add(response.timings.duration);
  } else {
    console.error(`Unexpected webhook response: HTTP ${response.status} ${response.body}`);
    unexpectedHttpFailures.add(1);
  }
}

function createScenario(iterations, vus, startTime) {
  return {
    executor: 'shared-iterations',
    vus: Math.min(vus, iterations),
    iterations,
    maxDuration: '30s',
    startTime,
    gracefulStop: '5s',
  };
}

function createScenarios(attempts, vus) {
  const phases = [
    ['warmup', attempts.warmup, Math.min(5, vus), '0s'],
    ['spike', attempts.spike, vus, '1s'],
    ['sustained', attempts.sustained, Math.max(1, Math.ceil(vus / 2)), '3s'],
    ['rampDown', attempts.rampDown, Math.min(5, vus), '5s'],
  ];

  return Object.fromEntries(
    phases.filter(([, iterations]) => iterations > 0).map(([name, iterations, phaseVus, startTime]) => [name, createScenario(iterations, phaseVus, startTime)]),
  );
}

function createPhaseAttempts(totalAttempts) {
  const warmup = Math.floor(totalAttempts * 0.05);
  const spike = Math.floor(totalAttempts * 0.6);
  const sustained = Math.floor(totalAttempts * 0.3);

  return { warmup, spike, sustained, rampDown: totalAttempts - warmup - spike - sustained };
}

function phaseOffset(phase, attempts) {
  if (phase === 'warmup') return 0;
  if (phase === 'spike') return attempts.warmup;
  if (phase === 'sustained') return attempts.warmup + attempts.spike;
  return attempts.warmup + attempts.spike + attempts.sustained;
}

function createDelivery(globalAttempt, uniqueCount, namespace) {
  const isStaleDelivery = globalAttempt % 2 === 1;
  const productIndex = Math.floor(globalAttempt / 2) % uniqueCount;
  const productId = `${namespace}:product:${String(productIndex).padStart(5, '0')}`;

  return {
    productId,
    // The runner seeds version 2 and waits for processing first. Every version 2 delivery is a
    // duplicate and every version 1 delivery is stale, regardless of concurrent worker ordering.
    version: isStaleDelivery ? 1 : 2,
    payload: {
      sku: `${namespace}-SKU-${String(productIndex).padStart(5, '0')}`,
      name: `Load product ${productIndex}`,
      price: '10.00',
      quantity: productIndex,
    },
    observedAt: '2026-09-08T00:00:00.000Z',
  };
}

function requiredText(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/$/, '');
}

function positiveInteger(name, fallback) {
  const raw = __ENV[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

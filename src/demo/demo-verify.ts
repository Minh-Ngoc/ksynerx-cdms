import { getDemoCounts, openStandaloneDataSource, scenarioFromEnvironment, evolvePayload } from './demo-runtime.js';

const scenario = scenarioFromEnvironment();
const dataSource = await openStandaloneDataSource();

try {
  const failures: string[] = [];
  const duplicateRows = await dataSource.query(`
    SELECT product_id, version, count(*)::int AS count
    FROM product_changes
    WHERE product_id LIKE 'demo-%'
    GROUP BY product_id, version
    HAVING count(*) > 1
  `) as Array<{ product_id: string; version: number; count: number }>;
  if (duplicateRows.length > 0) failures.push(`duplicate product/version history rows: ${JSON.stringify(duplicateRows)}`);

  const crossSourceRows = await dataSource.query(`
    SELECT product_id, version, source
    FROM product_changes
    WHERE product_id = 'demo-poll-015' AND version = 1
  `) as Array<{ product_id: string; version: number; source: string }>;
  if (crossSourceRows.length !== 1 || crossSourceRows[0]?.source !== 'POLLING') failures.push(`cross-source replay did not collapse to one accepted history row: ${JSON.stringify(crossSourceRows)}`);

  const stateMaxMismatches = await dataSource.query(`
    SELECT s.product_id, s.version AS state_version, max(c.version)::int AS max_history_version
    FROM product_state s
    LEFT JOIN product_changes c ON c.product_id = s.product_id
    WHERE s.product_id LIKE 'demo-%'
    GROUP BY s.product_id, s.version
    HAVING s.version <> max(c.version)
  `) as Array<Record<string, unknown>>;
  if (stateMaxMismatches.length > 0) failures.push(`state/version mismatches: ${JSON.stringify(stateMaxMismatches)}`);

  const stateRows = await dataSource.query(`SELECT count(*)::int AS count FROM product_state WHERE product_id LIKE 'demo-%'`) as Array<{ count: number }>;
  const changeRows = await dataSource.query(`SELECT count(*)::int AS count FROM product_changes WHERE product_id LIKE 'demo-%'`) as Array<{ count: number }>;
  const outboxRows = await dataSource.query(`SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id LIKE 'demo-%'`) as Array<{ count: number }>;
  if (Number(outboxRows[0]?.count ?? 0) !== Number(changeRows[0]?.count ?? 0)) failures.push('accepted change/outbox counts do not correspond');
  if (Number(stateRows[0]?.count ?? 0) !== 38) failures.push(`expected 38 demo product states, got ${stateRows[0]?.count ?? 0}`);

  const missingOutboxRows = await dataSource.query(`
    SELECT c.product_id, c.version
    FROM product_changes c
    LEFT JOIN outbox_events o
      ON o.aggregate_id = c.product_id
     AND o.payload->>'version' = c.version::text
    WHERE c.product_id LIKE 'demo-%' AND o.id IS NULL
  `) as Array<Record<string, unknown>>;
  if (missingOutboxRows.length > 0) failures.push(`history rows without an outbox event: ${JSON.stringify(missingOutboxRows)}`);

  const pollingVersionRows = await dataSource.query(`
    SELECT product_id, version
    FROM product_state
    WHERE product_id = ANY($1)
  `, [scenario.pollingProductIds.slice(0, 5)]) as Array<{ product_id: string; version: number }>;
  if (pollingVersionRows.filter((row) => scenario.pollingProductIds.slice(0, 3).includes(row.product_id)).some((row) => row.version !== 3)) failures.push(`polling v3 products regressed: ${JSON.stringify(pollingVersionRows)}`);
  if (pollingVersionRows.some((row) => row.version < 2)) failures.push(`stale webhook deliveries regressed state: ${JSON.stringify(pollingVersionRows)}`);

  const conflictProducts = scenario.conflictProductIds;
  const conflictRows = await dataSource.query(`
    SELECT product_id, version, payload
    FROM product_changes
    WHERE product_id = ANY($1) AND version = 3
    ORDER BY product_id
  `, [conflictProducts]) as Array<{ product_id: string; version: number; payload: Record<string, unknown> }>;
  const conflictStateRows = await dataSource.query(`
    SELECT product_id, payload
    FROM product_state
    WHERE product_id = ANY($1)
  `, [conflictProducts]) as Array<{ product_id: string; payload: Record<string, unknown> }>;
  if (conflictRows.length !== conflictProducts.length) failures.push(`same-version conflicts changed accepted history cardinality: ${conflictRows.length}`);
  for (const row of conflictRows) {
    const product = scenario.webhookProducts.find((candidate) => candidate.productId === row.product_id);
    const expectedPayload = product === undefined ? undefined : evolvePayload(product.payload, 3);
    const currentState = conflictStateRows.find((candidate) => candidate.product_id === row.product_id);
    if (expectedPayload === undefined || JSON.stringify(row.payload) !== JSON.stringify(expectedPayload) || currentState === undefined || JSON.stringify(currentState.payload) !== JSON.stringify(expectedPayload)) {
      failures.push(`same-version conflict overwrote ${row.product_id}`);
    }
  }

  const importInvariantRows = await dataSource.query(`
    SELECT id, status, rows_read, rows_processed, rows_succeeded, rows_failed, enqueue_completed_at, completed_at
    FROM import_jobs
    WHERE filename LIKE 'demo-%'
      AND (rows_processed <> rows_succeeded + rows_failed OR rows_processed > rows_read
        OR (status = 'COMPLETED' AND (enqueue_completed_at IS NULL OR completed_at IS NULL)))
  `) as Array<Record<string, unknown>>;
  if (importInvariantRows.length > 0) failures.push(`import progress invariant violations: ${JSON.stringify(importInvariantRows)}`);

  const importRows = await dataSource.query(`
    SELECT filename, status, rows_read, rows_succeeded, rows_failed
    FROM import_jobs
    WHERE filename LIKE 'demo-%'
    ORDER BY filename
  `) as Array<{ filename: string; status: string; rows_read: number; rows_succeeded: number; rows_failed: number }>;
  const validImport = importRows.find((row) => row.filename.includes('valid'));
  const partialImport = importRows.find((row) => row.filename.includes('partial'));
  if (validImport === undefined || validImport.status !== 'COMPLETED' || validImport.rows_read !== 11 || validImport.rows_succeeded !== 11 || validImport.rows_failed !== 0) {
    failures.push(`valid demo import did not finish with 11 successes: ${JSON.stringify(validImport)}`);
  }
  if (partialImport === undefined || partialImport.status !== 'COMPLETED' || partialImport.rows_read !== 10 || partialImport.rows_succeeded !== 8 || partialImport.rows_failed !== 2) {
    failures.push(`partial demo import did not finish with 8 successes and 2 failures: ${JSON.stringify(partialImport)}`);
  }

  const counts = await getDemoCounts(dataSource);
  const report = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    counts,
    checks: {
      duplicateProductVersionRows: duplicateRows.length,
      crossSourceHistoryRows: crossSourceRows.length,
      stateMaxMismatches: stateMaxMismatches.length,
      outboxMatchesChanges: counts.outbox === counts.changes,
      missingOutboxRows: missingOutboxRows.length,
      staleRegressionRows: pollingVersionRows.filter((row) => row.version < 2).length,
      conflictRowsAtVersion3: conflictRows.length,
      importInvariantViolations: importInvariantRows.length,
      imports: importRows,
    },
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) throw new Error('Demo verification failed');
} finally {
  await dataSource.destroy();
}

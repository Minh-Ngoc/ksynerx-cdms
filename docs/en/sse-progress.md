# SSE Progress

## Endpoints

- `GET /imports/:id` returns the durable import status.
- `GET /imports/:id/progress` returns `text/event-stream`.

SSE event names are `progress`, `completed`, and `failed`. Each event carries `importId`, `status`, `rowsRead`, `rowsProcessed`, `rowsSucceeded`, `rowsFailed`, `totalRows`, and `percent`.

## Authority and reconnects

PostgreSQL is authoritative. The server subscribes to Redis Pub/Sub before reading the durable row, then sends the latest PostgreSQL snapshot first. Notifications received during setup are buffered and emitted after that snapshot. Redis is only a live hint; a broken subscription closes the live view, and a reconnect reads PostgreSQL again.

Terminal status closes the stream. Client disconnects unsubscribe and disconnect the duplicated Redis subscriber. SSE is not durable messaging and does not replay an event history.

`percent` is `null` when `totalRows` is unknown. A zero-row completed import may report 100%; a zero-row non-terminal import does not fabricate a percentage. Progress snapshots are monotonic and do not regress counters or lifecycle status.

## Import invariants

The uploader increments `rowsRead`. Batch workers atomically account `rowsProcessed`, `rowsSucceeded`, and `rowsFailed`. PostgreSQL enforces:

```text
rowsProcessed = rowsSucceeded + rowsFailed
rowsProcessed <= rowsRead
COMPLETED => enqueue phase finished and rowsProcessed = rowsRead
```

Redis mirrors committed snapshots for low-latency live updates; it does not replace durable state.

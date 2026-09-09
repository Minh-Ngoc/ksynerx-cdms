# SSE Progress

## Endpoints

- `GET /imports/:id` tra import status ben vung.
- `GET /imports/:id/progress` tra `text/event-stream`.

Event name la `progress`, `completed`, va `failed`. Moi event co `importId`, `status`, `rowsRead`, `rowsProcessed`, `rowsSucceeded`, `rowsFailed`, `totalRows`, va `percent`.

## Authority va reconnect

PostgreSQL la authority. Server subscribe Redis Pub/Sub truoc khi doc durable row, sau do gui PostgreSQL snapshot moi nhat truoc. Notification den trong setup duoc buffer va emit sau snapshot. Redis chi la live hint; subscription hong se dong live view, reconnect se doc PostgreSQL lai.

Terminal status dong stream. Client disconnect unsubscribe va disconnect Redis subscriber duplicate. SSE khong phai durable messaging va khong replay event history.

`percent` la `null` khi chua biet `totalRows`. Import zero-row da completed co the tra 100%; zero-row chua terminal khong tao phan tram gia. Snapshot progress monotonic va khong lui counter hay lifecycle status.

## Import invariants

Uploader tang `rowsRead`. Batch worker atomically account `rowsProcessed`, `rowsSucceeded`, va `rowsFailed`. PostgreSQL enforce:

```text
rowsProcessed = rowsSucceeded + rowsFailed
rowsProcessed <= rowsRead
COMPLETED => enqueue phase finished and rowsProcessed = rowsRead
```

Redis mirror committed snapshot de live update nhanh; Redis khong thay the durable state.

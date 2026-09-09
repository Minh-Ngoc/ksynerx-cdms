# SSE Progress

## Endpoints

- `GET /imports/:id` trả import status bền vững.
- `GET /imports/:id/progress` trả `text/event-stream`.

Event name là `progress`, `completed`, và `failed`. Mỗi event có `importId`, `status`, `rowsRead`, `rowsProcessed`, `rowsSucceeded`, `rowsFailed`, `totalRows`, và `percent`.

## Authority và reconnect

PostgreSQL là authority. Server subscribe Redis Pub/Sub trước khi đọc durable row, sau đó gửi PostgreSQL snapshot mới nhất trước. Notification đến trong setup được buffer và emit sau snapshot. Redis chỉ là live hint; subscription hỏng sẽ làm gián đoạn live view, reconnect sẽ đọc PostgreSQL lại.

Terminal status đóng stream. Client disconnect sẽ hủy đăng ký và ngắt kết nối Redis subscriber đã tạo cho client. SSE không phải durable messaging và không replay event history.

`percent` là `null` khi chưa biết `totalRows`. Import zero-row đã completed có thể trả 100%; zero-row chưa terminal không tạo phần trăm giả. Snapshot progress monotonic và không lui counter hay lifecycle status.

## Import invariants

Uploader tăng `rowsRead`. Batch worker atomically account `rowsProcessed`, `rowsSucceeded`, và `rowsFailed`. PostgreSQL enforce:

```text
rowsProcessed = rowsSucceeded + rowsFailed
rowsProcessed <= rowsRead
COMPLETED => enqueue phase finished and rowsProcessed = rowsRead
```

Redis mirror committed snapshot để live update nhanh; Redis không thay thế durable state.

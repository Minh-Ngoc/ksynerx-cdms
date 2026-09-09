# Failure Handling

## Ingestion

- Webhook validation failure trả `400`. Redis/BullMQ failure trước `queue.add()` trả `503` retriable; webhook không ghi business database.
- Polling chỉ ghi composite checkpoint sau khi cả page được enqueue. Enqueue hoặc checkpoint failure giữ checkpoint cũ. Row đã enqueue có thể bị re-poll, an toàn vì processing idempotent.
- Excel failure khi đọc multipart, enforce size, parse workbook, hoặc retry Redis có giới hạn sẽ mark import `FAILED`. Batch đã BullMQ chấp nhận không bị rollback; `FAILED` nghĩa là ingestion không đạt normal terminal processing.

## Worker và database

- Database failure trước commit rollback transaction và BullMQ retry job.
- Worker crash trước commit không tạo accepted change dở dang.
- Worker crash sau commit có thể tạo job retry; PostgreSQL trả `DUPLICATE` hoặc `STALE` mà không tạo history row thứ hai.
- Import row failure bất ngờ được retry đến final BullMQ attempt. Ở final attempt, row đổ vào `rowsFailed` và các row khác vẫn có thể đạt terminal outcome.

## Outbox

Publisher claim bounded batch bằng `FOR UPDATE SKIP LOCKED`. Khi downstream enqueue fail, event vẫn pending và attempts/error được ghi. Nếu enqueue thành công nhưng `PUBLISHED` update fail, event sẽ được publish lại. Downstream consumer duplicate-tolerant: log trùng lặp được chấp nhận và business table không bị thay đổi.

## Progress và health

PostgreSQL là authority cho import lifecycle và counters. Redis Pub/Sub và Redis snapshot chỉ là live coordination best-effort. Redis Pub/Sub failure làm gián đoạn SSE live view; reconnect sẽ đọc PostgreSQL snapshot hiện tại. `GET /health` probe PostgreSQL và Redis độc lập, trả `503` nếu một dependency bắt buộc down. Health timeout một giây giới hạn HTTP probe nhưng không cancel PostgreSQL query đang chạy.

## Giới hạn

Mất Redis nghiêm trọng sau acknowledged enqueue có thể mất queued work chưa persist vào PostgreSQL. Prototype không implement PostgreSQL Inbox Pattern. Excel staging dùng local disk và parser chỉ hỗ trợ XLSX subset cần thiết.

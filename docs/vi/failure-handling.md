# Failure Handling

## Ingestion

- Webhook validation failure tra `400`. Redis/BullMQ failure truoc `queue.add()` tra `503` retriable; webhook khong ghi business database.
- Polling chi ghi composite checkpoint sau khi ca page duoc enqueue. Enqueue hoac checkpoint failure giu checkpoint cu. Row da enqueue co the bi re-poll, an toan vi processing idempotent.
- Excel failure khi doc multipart, enforce size, parse workbook, hoac retry Redis co gioi han se mark import `FAILED`. Batch da BullMQ chap nhan khong bi rollback; `FAILED` nghia la ingestion khong dat normal terminal processing.

## Worker va database

- Database failure truoc commit rollback transaction va BullMQ retry job.
- Worker crash truoc commit khong tao accepted change dang do.
- Worker crash sau commit co the tao job retry; PostgreSQL tra `DUPLICATE` hoac `STALE` ma khong tao history row thu hai.
- Import row failure bat ngo duoc retry den final BullMQ attempt. O final attempt, row do vao `rowsFailed` va cac row khac van co the dat terminal outcome.

## Outbox

Publisher claim bounded batch bang `FOR UPDATE SKIP LOCKED`. Khi downstream enqueue fail, event van pending va attempts/error duoc ghi. Neu enqueue thanh cong nhung `PUBLISHED` update fail, event se duoc publish lai. Downstream consumer duplicate-tolerant: log trung lap duoc chap nhan va business table khong bi thay doi.

## Progress va health

PostgreSQL la authority cho import lifecycle va counters. Redis Pub/Sub va Redis snapshot chi la live coordination best-effort. Redis Pub/Sub failure dong SSE live view; reconnect se doc PostgreSQL snapshot hien tai. `GET /health` probe PostgreSQL va Redis doc lap, tra `503` neu mot dependency bat buoc down. Health timeout mot giay gioi han HTTP probe nhung khong cancel PostgreSQL query dang chay.

## Gioi han

Mat Redis nghiem trong sau acknowledged enqueue co the mat queued work chua persist vao PostgreSQL. Prototype khong implement PostgreSQL Inbox Pattern. Excel staging dung local disk va parser chi ho tro XLSX subset can thiet.

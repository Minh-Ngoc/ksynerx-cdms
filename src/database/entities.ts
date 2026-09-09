import { ProductChangeEntity } from '../modules/changes/entities/product-change.entity.js';
import { ProductStateEntity } from '../modules/changes/entities/product-state.entity.js';
import { ImportJobEntity } from '../modules/imports/entities/import-job.entity.js';
import { ImportBatchAccountingEntity } from '../modules/imports/entities/import-batch-accounting.entity.js';
import { PollingCheckpointEntity } from '../modules/ingestion/entities/polling-checkpoint.entity.js';
import { InventoryProductEntity } from '../modules/inventory/entities/inventory-product.entity.js';
import { OutboxEventEntity } from '../modules/outbox/entities/outbox-event.entity.js';

export const DATABASE_ENTITIES = [
  InventoryProductEntity,
  ProductStateEntity,
  ProductChangeEntity,
  OutboxEventEntity,
  ImportJobEntity,
  ImportBatchAccountingEntity,
  PollingCheckpointEntity,
];

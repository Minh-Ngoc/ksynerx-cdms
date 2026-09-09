import { Injectable } from '@nestjs/common';

import { ProductChangeInput } from '../../changes/product-change-contract.js';
import { InventoryListQueryDto, InventoryProductResponse } from '../../inventory/dto/inventory-contracts.js';
import { InventoryService } from '../../inventory/inventory.service.js';
import { ChangeQueueProducer } from '../../queue/change-queue.producer.js';
import { normalizePollingProductChange } from '../polling-normalizer.js';
import { PollingCheckpointRepository } from './polling-checkpoint.repository.js';

export const INVENTORY_PRODUCTS_CHECKPOINT_NAME = 'inventory-products';

export interface PollingCursor {
  updatedAt: Date;
  productId: string;
}

export interface InventoryPageReader {
  list(query: InventoryListQueryDto): Promise<InventoryProductResponse[]>;
}

export interface PollingCheckpointStore {
  read(name: string): Promise<PollingCursor | null>;
  write(name: string, cursor: PollingCursor): Promise<void>;
}

export interface PollingChangeEnqueuer {
  enqueueChange(input: ProductChangeInput): Promise<unknown>;
}

export interface PollOnceResult {
  enqueued: number;
  checkpointAdvanced: boolean;
}

@Injectable()
export class PollingService {
  constructor(
    private readonly inventory: InventoryPageReader,
    private readonly checkpoints: PollingCheckpointStore,
    private readonly changeQueueProducer: PollingChangeEnqueuer,
  ) {}

  static fromNestDependencies(
    inventory: InventoryService,
    checkpoints: PollingCheckpointRepository,
    changeQueueProducer: ChangeQueueProducer,
  ): PollingService {
    return new PollingService(inventory, checkpoints, changeQueueProducer);
  }

  async pollOnce(): Promise<PollOnceResult> {
    const checkpoint = await this.checkpoints.read(INVENTORY_PRODUCTS_CHECKPOINT_NAME);
    const page = await this.inventory.list(toInventoryQuery(checkpoint));

    if (page.length === 0) {
      return { enqueued: 0, checkpointAdvanced: false };
    }

    for (const row of page) {
      // Polling still goes through BullMQ rather than ChangeProcessor directly so the API process only
      // performs durable ingestion; database/business correctness stays in the worker path.
      await this.changeQueueProducer.enqueueChange(normalizePollingProductChange(row));
    }

    const lastRow = page.at(-1);
    if (lastRow === undefined) {
      return { enqueued: 0, checkpointAdvanced: false };
    }

    // The checkpoint advances only after every row in the page has been accepted by BullMQ. If the
    // following DB write fails, already-enqueued jobs are not deleted because Redis enqueue + DB cursor
    // update is not a distributed transaction; the next poll may safely re-enqueue duplicates.
    await this.checkpoints.write(INVENTORY_PRODUCTS_CHECKPOINT_NAME, {
      updatedAt: new Date(lastRow.updatedAt),
      productId: lastRow.id,
    });

    return { enqueued: page.length, checkpointAdvanced: true };
  }
}

function toInventoryQuery(cursor: PollingCursor | null): InventoryListQueryDto {
  if (cursor === null) {
    return {};
  }

  return {
    updatedAfter: cursor.updatedAt.toISOString(),
    afterProductId: cursor.productId,
  };
}

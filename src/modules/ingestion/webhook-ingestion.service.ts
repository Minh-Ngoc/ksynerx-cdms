import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { ErrorCode } from '../../common/http/api-error.js';
import { ProductCanonicalizationError } from '../changes/product-canonicalization.js';
import { ProductChangeInput } from '../changes/product-change-contract.js';
import { ChangeQueueProducer } from '../queue/change-queue.producer.js';
import { InventoryWebhookAcceptedResponse, InventoryWebhookDto } from './dto/webhook-contracts.js';
import { normalizeWebhookProductChange } from './webhook-normalizer.js';

@Injectable()
export class WebhookIngestionService {
  private readonly logger = new Logger(WebhookIngestionService.name);

  constructor(
    @Inject(ChangeQueueProducer)
    private readonly changeQueueProducer: Pick<ChangeQueueProducer, 'enqueueChange'>,
  ) {}

  async accept(dto: InventoryWebhookDto): Promise<InventoryWebhookAcceptedResponse> {
    let input: ProductChangeInput;

    try {
      // The normalizer owns source assignment so clients cannot choose or spoof ingestion source.
      input = normalizeWebhookProductChange(dto);
    } catch (error) {
      if (error instanceof ProductCanonicalizationError) {
        throw new BadRequestException({
          statusCode: 400,
          code: ErrorCode.ValidationError,
          message: error.message,
        });
      }

      throw error;
    }

    try {
      // Duplicate webhook deliveries are intentionally allowed through HTTP. The 202 boundary is
      // Redis queue acceptance; duplicate/stale/conflict handling remains in ChangeProcessor/PostgreSQL.
      await this.changeQueueProducer.enqueueChange(input);
    } catch {
      this.logger.warn({ message: 'Inventory webhook enqueue failed; returning dependency failure' });
      // Queue failure means the request was not durably accepted for async processing, so this is a
      // retriable dependency failure rather than a business validation failure.
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: ErrorCode.DependencyUnavailable,
        message: 'Inventory webhook could not be accepted for asynchronous processing',
      });
    }

    return { status: 'ACCEPTED' };
  }
}

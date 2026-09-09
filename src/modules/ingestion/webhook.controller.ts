import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { InventoryWebhookAcceptedResponse, InventoryWebhookDto } from './dto/webhook-contracts.js';
import { WebhookIngestionService } from './webhook-ingestion.service.js';

@Controller('webhooks/inventory')
export class InventoryWebhookController {
  constructor(private readonly webhookIngestionService: WebhookIngestionService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async accept(@Body() dto: InventoryWebhookDto): Promise<InventoryWebhookAcceptedResponse> {
    return this.webhookIngestionService.accept(dto);
  }
}

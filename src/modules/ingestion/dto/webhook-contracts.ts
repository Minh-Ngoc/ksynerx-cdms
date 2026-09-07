import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateInventoryProductDto } from '../../inventory/dto/inventory-contracts.js';

export class InventoryWebhookPayloadDto extends CreateInventoryProductDto {}

export class InventoryWebhookDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  productId!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @ValidateNested()
  @Type(() => InventoryWebhookPayloadDto)
  payload!: InventoryWebhookPayloadDto;

  @IsOptional()
  @IsISO8601({ strict: true })
  observedAt?: string;
}

export interface InventoryWebhookAcceptedResponse {
  status: 'ACCEPTED';
}

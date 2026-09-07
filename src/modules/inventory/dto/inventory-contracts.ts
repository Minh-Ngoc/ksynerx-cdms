import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

import { IsProductDecimal } from '../../../common/validation/product-decimal.validator.js';

const PRODUCT_ID_MAX_LENGTH = 128;
const PRODUCT_SKU_MAX_LENGTH = 128;
const PRODUCT_NAME_MAX_LENGTH = 255;

@ValidatorConstraint({ name: 'hasAtLeastOneProductPatchField', async: false })
class HasAtLeastOneProductPatchFieldConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as UpdateInventoryProductDto;
    
    return (
      dto.sku !== undefined ||
      dto.name !== undefined ||
      dto.price !== undefined ||
      dto.quantity !== undefined
    );
  }

  defaultMessage(): string {
    return 'PATCH body must include at least one product field';
  }
}

export class ProductIdParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PRODUCT_ID_MAX_LENGTH)
  id!: string;
}

export class CreateInventoryProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PRODUCT_SKU_MAX_LENGTH)
  sku!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  name!: string;

  @IsProductDecimal()
  price!: string;

  @IsInt()
  @Min(0)
  quantity!: number;
}

export class UpdateInventoryProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PRODUCT_SKU_MAX_LENGTH)
  sku?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsProductDecimal()
  price?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  // Empty PATCH is rejected so later inventory mutation code never has to distinguish a no-op
  // request from a client bug while still preserving optional per-field validation.
  @Validate(HasAtLeastOneProductPatchFieldConstraint)
  private readonly atLeastOneProductField?: never;
}

export class InventoryListQueryDto {
  @ValidateIf((dto: InventoryListQueryDto) => dto.updatedAfter !== undefined || dto.afterProductId !== undefined)
  @IsISO8601({ strict: true }, { message: 'cursor.updatedAfter must be a valid ISO-8601 timestamp' })
  updatedAfter?: string;

  @ValidateIf((dto: InventoryListQueryDto) => dto.updatedAfter !== undefined || dto.afterProductId !== undefined)
  @IsString({ message: 'cursor.afterProductId must be a string when using a continuation cursor' })
  @IsNotEmpty({ message: 'cursor.afterProductId is required when updatedAfter is provided' })
  @MaxLength(PRODUCT_ID_MAX_LENGTH, {
    message: `cursor.afterProductId must be shorter than or equal to ${PRODUCT_ID_MAX_LENGTH} characters`,
  })
  afterProductId?: string;
}

export interface InventoryProductResponse {
  id: string;
  sku: string;
  name: string;
  price: string;
  quantity: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

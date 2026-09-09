import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import {
  CreateInventoryProductDto,
  InventoryListQueryDto,
  InventoryProductResponse,
  ProductIdParamDto,
  UpdateInventoryProductDto,
} from './dto/inventory-contracts.js';
import { InventoryService } from './inventory.service.js';

@Controller('inventory/products')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post()
  async create(@Body() dto: CreateInventoryProductDto): Promise<InventoryProductResponse> {
    return this.inventoryService.create(dto);
  }

  @Get()
  async list(@Query() query: InventoryListQueryDto): Promise<InventoryProductResponse[]> {
    return this.inventoryService.list(query);
  }

  @Get(':id')
  async getById(@Param() params: ProductIdParamDto): Promise<InventoryProductResponse> {
    return this.inventoryService.getById(params.id);
  }

  @Patch(':id')
  async update(
    @Param() params: ProductIdParamDto,
    @Body() dto: UpdateInventoryProductDto,
  ): Promise<InventoryProductResponse> {
    return this.inventoryService.update(params.id, dto);
  }
}

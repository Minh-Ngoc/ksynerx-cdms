import { randomUUID } from 'node:crypto';

import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { faker } from '@faker-js/faker';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import { ErrorCode } from '../../common/http/api-error.js';
import {
  CreateInventoryProductDto,
  InventoryListQueryDto,
  InventoryProductResponse,
  UpdateInventoryProductDto,
} from './dto/inventory-contracts.js';

const INVENTORY_SKU_UNIQUE_CONSTRAINT = 'uq_inventory_products_sku';
const POSTGRES_UNIQUE_VIOLATION = '23505';
const DEMO_SEED = 12_012;

interface InventoryProductRow {
  id: string;
  sku: string;
  name: string;
  price: string;
  quantity: number;
  version: number;
  created_at?: Date;
  updated_at?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

@Injectable()
export class InventoryService {
  constructor(private readonly dataSource: DataSource) {}

  async create(dto: CreateInventoryProductDto): Promise<InventoryProductResponse> {
    const now = new Date();

    try {
      const result = await this.dataSource.query(
        `
          INSERT INTO inventory_products (id, sku, name, price, quantity, version, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
          RETURNING id, sku, name, price::text, quantity, version, created_at, updated_at
        `,
        [randomUUID(), dto.sku, dto.name, dto.price, dto.quantity, now],
      );

      return mapInventoryProductRow(readFirstRow(result));
    } catch (error) {
      throw mapInventoryWriteError(error);
    }
  }

  async getById(id: string): Promise<InventoryProductResponse> {
    const [row] = await this.dataSource.query(
      `
        SELECT id, sku, name, price::text, quantity, version, created_at, updated_at
        FROM inventory_products
        WHERE id = $1
      `,
      [id],
    );

    if (!row) {
      throw inventoryProductNotFound();
    }

    return mapInventoryProductRow(row);
  }

  async list(query: InventoryListQueryDto): Promise<InventoryProductResponse[]> {
    const parameters: unknown[] = [];
    let cursorPredicate = '';

    if (query.updatedAfter !== undefined && query.afterProductId !== undefined) {
      parameters.push(new Date(query.updatedAfter), query.afterProductId);
      // This is the polling-safe composite cursor from the SPEC. The id tie-breaker prevents
      // rows sharing an updated_at value from being skipped between pages.
      cursorPredicate = `
        WHERE updated_at > $1
           OR (updated_at = $1 AND id > $2)
      `;
    }

    const rows = await this.dataSource.query(
      `
        SELECT id, sku, name, price::text, quantity, version, created_at, updated_at
        FROM inventory_products
        ${cursorPredicate}
        ORDER BY updated_at ASC, id ASC
      `,
      parameters,
    );

    return rows.map(mapInventoryProductRow);
  }

  async update(id: string, dto: UpdateInventoryProductDto): Promise<InventoryProductResponse> {
    try {
      return await this.dataSource.transaction(async (manager) => this.updateInsideTransaction(manager, id, dto));
    } catch (error) {
      throw mapInventoryWriteError(error);
    }
  }

  async seedIfNeeded(seedCount: number): Promise<void> {
    if (seedCount === 0) {
      return;
    }

    const [{ count }] = await this.dataSource.query('SELECT count(*)::int AS count FROM inventory_products');

    if (count > 0) {
      return;
    }

    faker.seed(DEMO_SEED);
    const baseTime = new Date('2026-09-07T00:00:00.000Z');
    const rows = Array.from({ length: seedCount }, (_, index) => {
      const ordinal = index + 1;

      return {
        id: `demo-product-${ordinal.toString().padStart(6, '0')}`,
        sku: `DEMO-SKU-${ordinal.toString().padStart(4, '0')}`,
        name: faker.commerce.productName(),
        price: formatSeedPrice(ordinal),
        quantity: faker.number.int({ min: 0, max: 500 }),
        createdAt: baseTime,
        updatedAt: new Date(baseTime.getTime() + ordinal),
      };
    });

    // Seeding is idempotent at the table level: once inventory exists, startup leaves it untouched.
    // This avoids silently overwriting demo mutations across API restarts.
    await this.dataSource.transaction(async (manager) => {
      for (const row of rows) {
        await manager.query(
          `
            INSERT INTO inventory_products (id, sku, name, price, quantity, version, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
            ON CONFLICT (id) DO NOTHING
          `,
          [row.id, row.sku, row.name, row.price, row.quantity, row.createdAt, row.updatedAt],
        );
      }
    });
  }

  private async updateInsideTransaction(
    manager: EntityManager,
    id: string,
    dto: UpdateInventoryProductDto,
  ): Promise<InventoryProductResponse> {
    const [current] = await manager.query(
      `
        SELECT id, sku, name, price::text, quantity, version, created_at, updated_at
        FROM inventory_products
        WHERE id = $1
        FOR UPDATE
      `,
      [id],
    );

    if (!current) {
      throw inventoryProductNotFound();
    }

    const currentRow = current as InventoryProductRow;
    const nextUpdatedAt = nextCursorSafeTimestamp(readTimestamp(currentRow, 'updatedAt'));

    // The row lock serializes concurrent PATCH calls so each committed mutation observes the
    // previous committed version and increments from it exactly once.
    const result = await manager.query(
      `
        UPDATE inventory_products
        SET
          sku = $2,
          name = $3,
          price = $4,
          quantity = $5,
          version = version + 1,
          updated_at = $6
        WHERE id = $1
        RETURNING id, sku, name, price::text, quantity, version, created_at, updated_at
      `,
      [
        id,
        dto.sku ?? currentRow.sku,
        dto.name ?? currentRow.name,
        dto.price ?? currentRow.price,
        dto.quantity ?? currentRow.quantity,
        nextUpdatedAt,
      ],
    );

    return mapInventoryProductRow(readFirstRow(result));
  }
}

function readFirstRow(result: unknown): InventoryProductRow {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  const [row] = rows as InventoryProductRow[];

  return row;
}

function nextCursorSafeTimestamp(currentUpdatedAt: Date): Date {
  const now = new Date();
  const nextTime = Math.max(now.getTime(), currentUpdatedAt.getTime() + 1);

  // The emulator writes millisecond-precision timestamps because JS Date is the public cursor
  // representation; keeping writes at that precision avoids a microsecond value the API cannot echo.
  return new Date(nextTime);
}

function mapInventoryProductRow(row: InventoryProductRow): InventoryProductResponse {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: row.price,
    quantity: Number(row.quantity),
    version: Number(row.version),
    createdAt: readTimestamp(row, 'createdAt').toISOString(),
    updatedAt: readTimestamp(row, 'updatedAt').toISOString(),
  };
}

function readTimestamp(row: InventoryProductRow, field: 'createdAt' | 'updatedAt'): Date {
  const value = field === 'createdAt' ? (row.created_at ?? row.createdAt) : (row.updated_at ?? row.updatedAt);

  if (value instanceof Date) {
    return value;
  }

  return new Date(value as unknown as string);
}

function mapInventoryWriteError(error: unknown): Error {
  if (isInventorySkuConflict(error)) {
    // Only the known SKU uniqueness constraint maps to 409; broad DB-error translation would hide
    // unexpected persistence failures behind a business conflict response.
    return new ConflictException({
      statusCode: 409,
      code: ErrorCode.Conflict,
      message: 'Inventory product SKU already exists',
    });
  }

  if (error instanceof NotFoundException) {
    return error;
  }

  if (error instanceof Error) {
    return error;
  }

  return new InternalServerErrorException({
    statusCode: 500,
    code: ErrorCode.InternalError,
    message: 'Inventory product write failed',
  });
}

function isInventorySkuConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = error.driverError as { code?: string; constraint?: string };
  return driverError.code === POSTGRES_UNIQUE_VIOLATION && driverError.constraint === INVENTORY_SKU_UNIQUE_CONSTRAINT;
}

function inventoryProductNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: ErrorCode.NotFound,
    message: 'Inventory product not found',
  });
}

function formatSeedPrice(ordinal: number): string {
  const dollars = 10 + (ordinal % 990);
  const cents = (ordinal % 100).toString().padStart(2, '0');

  return `${dollars}.${cents}`;
}

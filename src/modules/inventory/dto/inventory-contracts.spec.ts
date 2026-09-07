import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import {
  CreateInventoryProductDto,
  InventoryListQueryDto,
  UpdateInventoryProductDto,
} from './inventory-contracts.js';

async function validationMessages(dto: object): Promise<string[]> {
  const errors = await validate(dto, {
    forbidUnknownValues: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('inventory API DTO contracts', () => {
  it('accepts a valid create product contract and keeps price as a string', async () => {
    const dto = plainToInstance(CreateInventoryProductDto, {
      sku: 'SKU-001',
      name: 'Desk',
      price: '123.45',
      quantity: 0,
    });

    await expect(validationMessages(dto)).resolves.toEqual([]);
    expect(dto.price).toBe('123.45');
    expect(typeof dto.price).toBe('string');
  });

  it('rejects missing required create fields', async () => {
    const dto = plainToInstance(CreateInventoryProductDto, {});

    await expect(validationMessages(dto)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining('sku'),
        expect.stringContaining('name'),
        expect.stringContaining('price'),
        expect.stringContaining('quantity'),
      ]),
    );
  });

  it('rejects oversized sku and name values', async () => {
    const dto = plainToInstance(CreateInventoryProductDto, {
      sku: 'S'.repeat(129),
      name: 'N'.repeat(256),
      price: '1.00',
      quantity: 1,
    });

    await expect(validationMessages(dto)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining('sku'),
        expect.stringContaining('name'),
      ]),
    );
  });

  it.each(['NaN', '1e3', '1.234', '-1.00', '12345678901234567.89'])(
    'rejects invalid decimal-string price %s',
    async (price) => {
      const dto = plainToInstance(CreateInventoryProductDto, {
        sku: 'SKU-001',
        name: 'Desk',
        price,
        quantity: 1,
      });

      await expect(validationMessages(dto)).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('price')]),
      );
    },
  );

  it('rejects floating quantity values', async () => {
    const dto = plainToInstance(CreateInventoryProductDto, {
      sku: 'SKU-001',
      name: 'Desk',
      price: '1.00',
      quantity: 1.5,
    });

    await expect(validationMessages(dto)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('quantity')]),
    );
  });

  it('allows partial PATCH fields but rejects an empty PATCH request', async () => {
    const validPatch = plainToInstance(UpdateInventoryProductDto, {
      price: '2.50',
    });
    const emptyPatch = plainToInstance(UpdateInventoryProductDto, {});

    await expect(validationMessages(validPatch)).resolves.toEqual([]);
    await expect(validationMessages(emptyPatch)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('at least one')]),
    );
  });

  it('accepts either no cursor or the complete composite cursor pair', async () => {
    await expect(validationMessages(plainToInstance(InventoryListQueryDto, {}))).resolves.toEqual([]);

    await expect(
      validationMessages(
        plainToInstance(InventoryListQueryDto, {
          updatedAfter: '2026-01-02T03:04:05.000Z',
          afterProductId: 'product-1',
        }),
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    { updatedAfter: '2026-01-02T03:04:05.000Z' },
    { afterProductId: 'product-1' },
  ])('rejects a half composite cursor: %p', async (query) => {
    await expect(validationMessages(plainToInstance(InventoryListQueryDto, query))).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('cursor')]),
    );
  });
});

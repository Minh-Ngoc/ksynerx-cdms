import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { InventoryWebhookDto } from './webhook-contracts.js';

async function validationMessages(dto: object): Promise<string[]> {
  const errors = await validate(dto, {
    forbidUnknownValues: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('inventory webhook DTO contract', () => {
  it('accepts a valid webhook payload without a client-selected source', async () => {
    const dto = plainToInstance(InventoryWebhookDto, {
      productId: 'product-1',
      version: 1,
      payload: {
        sku: 'SKU-001',
        name: 'Desk',
        price: '123.45',
        quantity: 3,
      },
      observedAt: '2026-01-02T03:04:05.000Z',
    });

    await expect(validationMessages(dto)).resolves.toEqual([]);
  });

  it('rejects a non-positive version', async () => {
    const dto = plainToInstance(InventoryWebhookDto, {
      productId: 'product-1',
      version: 0,
      payload: {
        sku: 'SKU-001',
        name: 'Desk',
        price: '123.45',
        quantity: 3,
      },
    });

    await expect(validationMessages(dto)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('version')]),
    );
  });

  it('rejects malformed observedAt timestamps', async () => {
    const dto = plainToInstance(InventoryWebhookDto, {
      productId: 'product-1',
      version: 1,
      payload: {
        sku: 'SKU-001',
        name: 'Desk',
        price: '123.45',
        quantity: 3,
      },
      observedAt: 'not-a-date',
    });

    await expect(validationMessages(dto)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('observedAt')]),
    );
  });

  it('rejects an unexpected client source field', async () => {
    const dto = plainToInstance(InventoryWebhookDto, {
      productId: 'product-1',
      version: 1,
      source: 'WEBHOOK',
      payload: {
        sku: 'SKU-001',
        name: 'Desk',
        price: '123.45',
        quantity: 3,
      },
    });

    await expect(validationMessages(dto)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('source')]),
    );
  });
});

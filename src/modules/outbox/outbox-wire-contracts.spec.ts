import { serializeOutboxDownstreamJob } from './outbox-wire-contracts.js';

describe('outbox downstream wire contract', () => {
  it('serializes committed outbox rows into explicit stable downstream job data', () => {
    const data = serializeOutboxDownstreamJob({
      id: '11111111-1111-4111-8111-111111111111',
      aggregateId: 'product-1',
      eventType: 'PRODUCT_CHANGE_ACCEPTED',
      payload: { productId: 'product-1', version: 3 },
      createdAt: new Date('2026-01-02T03:04:05.678Z'),
    });

    expect(data).toEqual({
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      aggregateId: 'product-1',
      eventType: 'PRODUCT_CHANGE_ACCEPTED',
      payload: { productId: 'product-1', version: 3 },
      createdAt: '2026-01-02T03:04:05.678Z',
    });
  });
});

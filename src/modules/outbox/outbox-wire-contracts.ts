import { OutboxEventEntity } from './entities/outbox-event.entity.js';

export interface OutboxEventForPublication {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface OutboxDownstreamJobData {
  outboxEventId: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function serializeOutboxDownstreamJob(
  event: Pick<OutboxEventEntity, 'id' | 'aggregateId' | 'eventType' | 'payload' | 'createdAt'>,
): OutboxDownstreamJobData {
  return {
    outboxEventId: event.id,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

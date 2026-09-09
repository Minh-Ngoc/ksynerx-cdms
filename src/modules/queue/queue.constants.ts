import { JobsOptions } from 'bullmq';

export const QUEUE_NAMES = {
  change: 'cdms-change',
  importBatch: 'cdms-import-batch',
  downstream: 'cdms-downstream',
} as const;

export const CHANGE_QUEUE_JOB_NAME = 'process-product-change';
export const IMPORT_BATCH_JOB_NAME = 'process-import-batch';
export const OUTBOX_DOWNSTREAM_JOB_NAME = 'publish-outbox-event';

export const QUEUE_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

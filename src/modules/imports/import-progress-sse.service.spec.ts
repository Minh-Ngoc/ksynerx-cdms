import { firstValueFrom, toArray } from 'rxjs';

import { ImportJobStatus } from './dto/import-contracts.js';
import type { PersistedImportJob } from './import-job.repository.js';
import { ImportProgressReadService } from './import-progress-read.service.js';

describe('import progress SSE message contract', () => {
  it('emits Nest-compatible progress and terminal events with the same snapshot payload', async () => {
    const job = completedImport();
    const service = new ImportProgressReadService(
      { findById: async () => job },
      { subscribe: async () => async () => undefined },
    );

    const events = await firstValueFrom((await service.stream(job.id, new AbortController().signal)).pipe(toArray()));
    expect(events).toEqual([
      expect.objectContaining({ type: 'progress', data: expect.objectContaining({ importId: job.id, rowsFailed: 1 }) }),
      expect.objectContaining({ type: 'completed', data: expect.objectContaining({ importId: job.id, rowsFailed: 1 }) }),
    ]);
  });
});

function completedImport(): PersistedImportJob {
  return {
    id: 'import-1',
    filename: 'products.xlsx',
    status: ImportJobStatus.Completed,
    rowsRead: 3,
    rowsProcessed: 3,
    rowsSucceeded: 2,
    rowsFailed: 1,
    totalRows: 3,
    enqueueCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:01:00.000Z'),
    error: null,
  };
}

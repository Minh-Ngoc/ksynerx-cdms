import { firstValueFrom, toArray } from 'rxjs';

import { ImportJobStatus, type ImportProgressSnapshot } from './dto/import-contracts.js';
import type { PersistedImportJob } from './import-job.repository.js';
import { ImportProgressReadService } from './import-progress-read.service.js';

describe('ImportProgressReadService', () => {
  it('maps a durable import status and preserves a completed import with failed rows', async () => {
    const imports = new RecordingImports(completedImport());
    const live = new RecordingLiveProgress();
    const service = new ImportProgressReadService(imports, live);

    await expect(service.getStatus('import-1')).resolves.toEqual({
      id: 'import-1',
      filename: 'products.xlsx',
      status: ImportJobStatus.Completed,
      rowsRead: 3,
      rowsProcessed: 3,
      rowsSucceeded: 2,
      rowsFailed: 1,
      totalRows: 3,
      enqueueCompletedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      error: null,
    });
  });

  it('returns not found before opening a live subscription', async () => {
    const live = new RecordingLiveProgress();
    const service = new ImportProgressReadService(new RecordingImports(null), live);

    await expect(service.stream('missing', new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(live.subscriptionCount).toBe(0);
  });

  it('uses null percent for unknown totals and 100 for a completed empty import', async () => {
    const live = new RecordingLiveProgress();
    const service = new ImportProgressReadService(new RecordingImports(processingImport({ totalRows: null })), live);
    const unknown = await firstValueFrom(await service.stream('import-1', new AbortController().signal));

    expect(unknown.data).toMatchObject({ importId: 'import-1', percent: null });

    const empty = new ImportProgressReadService(
      new RecordingImports(completedImport({ rowsRead: 0, rowsProcessed: 0, rowsSucceeded: 0, rowsFailed: 0, totalRows: 0 })),
      new RecordingLiveProgress(),
    );
    const events = await firstValueFrom((await empty.stream('import-1', new AbortController().signal)).pipe(toArray()));
    expect(events[0]).toMatchObject({ type: 'progress', data: { percent: 100 } });
  });

  it('emits the latest snapshot then a completed terminal event and closes', async () => {
    const service = new ImportProgressReadService(new RecordingImports(completedImport()), new RecordingLiveProgress());

    await expect(firstValueFrom((await service.stream('import-1', new AbortController().signal)).pipe(toArray()))).resolves.toEqual([
      expect.objectContaining({ type: 'progress', data: expect.objectContaining({ importId: 'import-1' }) }),
      expect.objectContaining({ type: 'completed', data: expect.objectContaining({ status: ImportJobStatus.Completed }) }),
    ]);
  });

  it('preserves failed counters in a failed terminal event', async () => {
    const failed = processingImport({
      status: ImportJobStatus.Failed,
      rowsRead: 3,
      rowsProcessed: 2,
      rowsSucceeded: 1,
      rowsFailed: 1,
      totalRows: 3,
      error: 'upload parser failed after queueing a batch',
    });
    const service = new ImportProgressReadService(new RecordingImports(failed), new RecordingLiveProgress());

    await expect(firstValueFrom((await service.stream('import-1', new AbortController().signal)).pipe(toArray()))).resolves.toEqual([
      expect.objectContaining({ type: 'progress', data: expect.objectContaining({ rowsProcessed: 2, rowsFailed: 1 }) }),
      expect.objectContaining({ type: 'failed', data: expect.objectContaining({ status: ImportJobStatus.Failed }) }),
    ]);
  });

  it('emits a live non-regressing snapshot and cleans its own subscription on disconnect', async () => {
    const imports = new RecordingImports(processingImport());
    const live = new RecordingLiveProgress();
    const service = new ImportProgressReadService(imports, live);
    const stream = await service.stream('import-1', new AbortController().signal);
    const received: unknown[] = [];
    const subscription = stream.subscribe((event) => received.push(event));

    live.emit(snapshot({ rowsRead: 2, rowsProcessed: 1, rowsSucceeded: 1, totalRows: 2 }));
    expect(received).toHaveLength(2);

    subscription.unsubscribe();
    expect(live.unsubscribeCount).toBe(1);
  });

  it('does not allow a stale notification to regress visible progress', async () => {
    const imports = new RecordingImports(processingImport({ rowsRead: 2, rowsProcessed: 1, rowsSucceeded: 1, totalRows: 2 }));
    const live = new RecordingLiveProgress();
    const service = new ImportProgressReadService(imports, live);
    const stream = await service.stream('import-1', new AbortController().signal);

    const events: unknown[] = [];
    const subscription = stream.subscribe((event) => events.push(event));
    live.emit(snapshot({ rowsRead: 2, rowsProcessed: 0, rowsSucceeded: 0, totalRows: 2 }));

    expect(events).toHaveLength(1);
    subscription.unsubscribe();
  });

  it('subscribes before the durable read so a setup-race notification is not lost', async () => {
    const imports = new RecordingImports(processingImport({ rowsRead: 1, rowsProcessed: 0, totalRows: 1 }));
    const live = new RecordingLiveProgress();
    live.onSubscribe = () => {
      imports.current = processingImport({ rowsRead: 1, rowsProcessed: 1, rowsSucceeded: 1, totalRows: 1, status: ImportJobStatus.Completed });
    };
    const service = new ImportProgressReadService(imports, live);

    const initial = await firstValueFrom(await service.stream('import-1', new AbortController().signal));
    expect(initial.data).toMatchObject({ rowsProcessed: 1, status: ImportJobStatus.Completed });
  });

  it('keeps multiple client subscriptions independent and cleans each one', async () => {
    const imports = new RecordingImports(processingImport());
    const live = new RecordingLiveProgress();
    const service = new ImportProgressReadService(imports, live);
    const first = (await service.stream('import-1', new AbortController().signal)).subscribe();
    const second = (await service.stream('import-1', new AbortController().signal)).subscribe();

    first.unsubscribe();
    expect(live.unsubscribeCount).toBe(1);
    expect(live.listenerCount).toBe(1);

    second.unsubscribe();
    expect(live.unsubscribeCount).toBe(2);
  });

  it('closes a live stream cleanly when Redis notifications fail', async () => {
    const live = new RecordingLiveProgress();
    const stream = await new ImportProgressReadService(new RecordingImports(processingImport()), live)
      .stream('import-1', new AbortController().signal);
    let completed = false;
    stream.subscribe({ complete: () => { completed = true; } });

    live.fail(new Error('Redis disconnected'));
    expect(completed).toBe(true);
    expect(live.unsubscribeCount).toBe(1);
  });
});

class RecordingImports {
  current: PersistedImportJob | null;

  constructor(current: PersistedImportJob | null) {
    this.current = current;
  }

  async findById(): Promise<PersistedImportJob | null> {
    return this.current;
  }
}

class RecordingLiveProgress {
  subscriptionCount = 0;
  unsubscribeCount = 0;
  onSubscribe?: () => void;
  private readonly listeners = new Set<(snapshot: ImportProgressSnapshot) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  async subscribe(
    _importId: string,
    listener: (snapshot: ImportProgressSnapshot) => void,
    onError: (error: Error) => void,
  ): Promise<() => Promise<void>> {
    this.subscriptionCount += 1;
    this.listeners.add(listener);
    this.errorListeners.add(onError);
    this.onSubscribe?.();
    return async () => {
      this.unsubscribeCount += 1;
      this.listeners.delete(listener);
      this.errorListeners.delete(onError);
    };
  }

  emit(next: ImportProgressSnapshot): void {
    for (const listener of this.listeners) listener(next);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function processingImport(overrides: Partial<PersistedImportJob> = {}): PersistedImportJob {
  return {
    ...baseImport(),
    status: ImportJobStatus.Processing,
    ...overrides,
  };
}

function completedImport(overrides: Partial<PersistedImportJob> = {}): PersistedImportJob {
  return {
    ...baseImport(),
    status: ImportJobStatus.Completed,
    rowsRead: 3,
    rowsProcessed: 3,
    rowsSucceeded: 2,
    rowsFailed: 1,
    totalRows: 3,
    enqueueCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:01:00.000Z'),
    ...overrides,
  };
}

function baseImport(): PersistedImportJob {
  return {
    id: 'import-1',
    filename: 'products.xlsx',
    status: ImportJobStatus.Processing,
    rowsRead: 2,
    rowsProcessed: 0,
    rowsSucceeded: 0,
    rowsFailed: 0,
    totalRows: 2,
    enqueueCompletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: null,
    error: null,
  };
}

function snapshot(overrides: Partial<ImportProgressSnapshot>): ImportProgressSnapshot {
  return {
    importId: 'import-1',
    status: ImportJobStatus.Processing,
    rowsRead: 2,
    rowsProcessed: 0,
    rowsSucceeded: 0,
    rowsFailed: 0,
    totalRows: 2,
    percent: 0,
    ...overrides,
  };
}

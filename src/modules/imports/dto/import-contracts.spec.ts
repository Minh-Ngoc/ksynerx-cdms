import { ImportJobStatus, createImportProgressSnapshot } from './import-contracts.js';

describe('import API response contracts', () => {
  it('represents the create response as PROCESSING after enqueue production finishes', () => {
    const response = {
      importId: 'import-1',
      status: ImportJobStatus.Processing,
    };

    expect(response).toEqual({
      importId: 'import-1',
      status: 'PROCESSING',
    });
  });

  it('does not fabricate percent when totalRows is unknown', () => {
    expect(
      createImportProgressSnapshot({
        id: 'import-1',
        status: ImportJobStatus.Processing,
        rowsRead: 5,
        rowsProcessed: 2,
        rowsSucceeded: 1,
        rowsFailed: 1,
        totalRows: null,
      }),
    ).toMatchObject({
      percent: null,
    });
  });
});

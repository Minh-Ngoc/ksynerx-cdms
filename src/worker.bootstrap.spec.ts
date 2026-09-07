import { INestApplicationContext } from '@nestjs/common';

import { createWorkerApplicationContext } from './worker.bootstrap.js';

describe('createWorkerApplicationContext', () => {
  it('creates a standalone Nest context without starting an HTTP listener', async () => {
    const calls: unknown[] = [];
    const applicationContext = { close: async () => undefined } as INestApplicationContext;
    const createApplicationContext = async (module: unknown) => {
      calls.push(module);
      return applicationContext;
    };
    const createCalls: unknown[] = [];

    const result = await createWorkerApplicationContext({
      createApplicationContext,
      create: (module: unknown) => createCalls.push(module),
    });

    expect(result).toBe(applicationContext);
    expect(calls).toHaveLength(1);
    expect(createCalls).toHaveLength(0);
  });
});

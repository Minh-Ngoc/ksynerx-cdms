import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from './app.module.js';

describe('AppModule', () => {
  it('compiles the root Nest module', async () => {
    const dataSource = {
      isInitialized: false,
      manager: {},
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DataSource)
      .useValue(dataSource)
      .compile();

    expect(moduleRef).toBeDefined();
    expect(moduleRef.get(DataSource)).toBe(dataSource);

    await moduleRef.close();
  });
});

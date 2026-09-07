import { AppDataSource } from './data-source.js';

const command = process.argv[2];

if (command !== 'run' && command !== 'revert') {
  throw new Error('Usage: pnpm migration:run | pnpm migration:revert');
}

await AppDataSource.initialize();

try {
  if (command === 'run') {
    await AppDataSource.runMigrations();
  } else {
    await AppDataSource.undoLastMigration();
  }
} finally {
  await AppDataSource.destroy();
}

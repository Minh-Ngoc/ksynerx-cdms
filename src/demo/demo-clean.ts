import { cleanDemoData, createStandaloneDemoQueues, openStandaloneDataSource, removePendingDemoJobs } from './demo-runtime.js';

const dataSource = await openStandaloneDataSource();
const queues = createStandaloneDemoQueues();
try {
  await removePendingDemoJobs(queues);
  console.log(JSON.stringify({ remainingDemoRows: await cleanDemoData(dataSource) }, null, 2));
} finally {
  await Promise.all(queues.map((queue) => queue.close()));
  await dataSource.destroy();
}

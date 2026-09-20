import path from 'node:path';
import { App } from './app.mjs';
import { JsonlEventStore, JsonPartitionStore } from './store/file-store.mjs';
import { createAppServer } from './http/app-server.mjs';

export async function createServer({ dataDir = process.env.DATA_DIR ?? path.resolve('data') } = {}) {
  const app = new App({
    eventStore: new JsonlEventStore(path.join(dataDir, 'events.log')),
    contactStore: new JsonPartitionStore(path.join(dataDir, 'contacts.json')),
    researchStore: new JsonPartitionStore(path.join(dataDir, 'research.json')),
  });
  await app.init();
  return createAppServer(app);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().then((server) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`服务已启动：http://0.0.0.0:${port}`);
    });
  }).catch((error) => {
    console.error('服务启动失败：', error);
    process.exit(1);
  });
}

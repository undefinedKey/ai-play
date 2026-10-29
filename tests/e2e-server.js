import { createApp } from '../server/index.js';
const application = await createApp({ dbPath: ':memory:', production: true });
const { server } = await application.start(3107);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await application.close(); server.closeAllConnections(); server.close(() => process.exit(0)); });

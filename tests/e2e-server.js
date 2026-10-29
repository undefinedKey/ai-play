import { createApp } from '../server/index.js';
// Explicit legacy runner coverage. Production and other browser fixtures default to real AI only.
const application = await createApp({ dbPath: ':memory:', production: true, demo: true });
const { server } = await application.start(3107);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await application.close(); server.closeAllConnections(); server.close(() => process.exit(0)); });

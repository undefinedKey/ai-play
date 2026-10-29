import { createApp } from '../server/index.js';
const application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', authMode: 'accounts', publicUrl: 'http://127.0.0.1:3108', allowHttp: true, production: true });
await application.accounts.createAdmin({ username: 'admin_test', password: 'Only-for-browser-tests-2026!', name: '测试管理员' });
const { server } = await application.start(3108);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await application.close(); server.closeAllConnections(); server.close(() => process.exit(0)); });

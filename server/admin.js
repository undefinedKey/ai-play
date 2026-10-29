import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AccountStore } from './auth.js';

export async function runAdmin({ args = process.argv.slice(2), env = process.env, write = message => console.log(message), writeError = message => console.error(message) } = {}) {
  if (args.length !== 1 || args[0] !== 'create-admin') {
    writeError('用法：node --env-file=/安全目录/admin.env server/admin.js create-admin');
    return 1;
  }
  if (!env.PLAZA_ADMIN_USERNAME || !env.PLAZA_ADMIN_PASSWORD) {
    writeError('请通过环境变量设置 PLAZA_ADMIN_USERNAME 和 PLAZA_ADMIN_PASSWORD。');
    return 1;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const worldPath = resolve(env.PLAZA_DB || resolve(root, 'data/world.sqlite'));
  const dbPath = resolve(env.PLAZA_AUTH_DB || resolve(dirname(worldPath), 'auth.sqlite'));
  let store;
  try {
    store = new AccountStore({ dbPath });
    const owner = await store.createAdmin({ username: env.PLAZA_ADMIN_USERNAME, password: env.PLAZA_ADMIN_PASSWORD, name: env.PLAZA_ADMIN_NAME || env.PLAZA_ADMIN_USERNAME });
    write(`管理员账号已创建：${owner.username}`);
    return 0;
  } catch (error) {
    writeError(error.code ? `创建管理员失败：${error.message}` : '创建管理员失败，请检查配置和数据库。');
    return 1;
  } finally { store?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runAdmin();

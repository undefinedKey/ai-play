import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AccountStore } from './auth.js';

export async function runAdmin({ args = process.argv.slice(2), env = process.env, write = message => console.log(message), writeError = message => console.error(message) } = {}) {
  const creating = args[0] === 'create-admin' && (args.length === 1 || args.length === 2 && args[1] === '--passwordless');
  const passwordless = creating && args.includes('--passwordless');
  const linking = args.length === 3 && args[0] === 'login-link' && args[1] === '--username';
  if (!creating && !linking) {
    writeError('用法：server/admin.js create-admin [--passwordless] 或 login-link --username 用户名；通过安全环境文件指定数据库与 PLAZA_PUBLIC_URL。');
    return 1;
  }
  if (creating && (!env.PLAZA_ADMIN_USERNAME || !passwordless && !env.PLAZA_ADMIN_PASSWORD)) {
    writeError('请通过环境变量设置 PLAZA_ADMIN_USERNAME 和 PLAZA_ADMIN_PASSWORD。');
    return 1;
  }
  let publicOrigin;
  if (linking || passwordless) {
    try {
      const url = new URL(env.PLAZA_PUBLIC_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      publicOrigin = url.origin;
    } catch { writeError('签发登录链接前请设置有效的 PLAZA_PUBLIC_URL（仅协议、主机和端口）。'); return 1; }
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const worldPath = resolve(env.PLAZA_DB || resolve(root, 'data/world.sqlite'));
  const dbPath = resolve(env.PLAZA_AUTH_DB || resolve(dirname(worldPath), 'auth.sqlite'));
  let store;
  try {
    store = new AccountStore({ dbPath });
    const owner = creating ? await store.createAdmin({ username: env.PLAZA_ADMIN_USERNAME, password: passwordless ? undefined : env.PLAZA_ADMIN_PASSWORD, passwordless, name: env.PLAZA_ADMIN_NAME || env.PLAZA_ADMIN_USERNAME }) : store.getOwnerByUsername(args[2]);
    if (!owner) { writeError('账号不存在，不能签发登录链接。'); return 1; }
    if (creating) write(`管理员账号已创建：${owner.username}`);
    if (linking || passwordless) {
      const ticket = store.createLoginTicket(owner.id);
      write(JSON.stringify({ username: owner.username, login_url: `${publicOrigin}/#login=${ticket.token}`, expires_at: ticket.expires_at }));
    }
    return 0;
  } catch (error) {
    writeError(error.code ? `账号操作失败：${error.message}` : '账号操作失败，请检查配置和数据库。');
    return 1;
  } finally { store?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runAdmin();

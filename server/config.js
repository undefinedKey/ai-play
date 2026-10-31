import { resolve, dirname } from 'node:path';

export const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${name} 必须为 ${min}–${max} 的整数`);
  return Number(value);
}

export function deploymentConfig(options = {}) {
  const mode = options.authMode ?? process.env.PLAZA_AUTH_MODE ?? 'local';
  if (!['local', 'accounts'].includes(mode)) throw new Error('PLAZA_AUTH_MODE 必须为 local 或 accounts');
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('HOST 必须为 127.0.0.1、::1 或 0.0.0.0');
  if (mode === 'local' && !isLoopback(host)) throw new Error('本地演示模式禁止监听公网；服务器部署请使用 PLAZA_AUTH_MODE=accounts');
  const publicAddress = options.publicUrl ?? process.env.PLAZA_PUBLIC_URL;
  let publicUrl = null;
  if (publicAddress) {
    try { publicUrl = new URL(publicAddress); } catch { throw new Error('PLAZA_PUBLIC_URL 不是有效网址'); }
    if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PLAZA_PUBLIC_URL 仅填写 http(s)://主机:端口，不含路径或凭证');
  }
  if (mode === 'accounts' && !publicUrl) throw new Error('服务器账号模式必须设置 PLAZA_PUBLIC_URL');
  if (mode === 'accounts' && publicUrl.protocol === 'http:' && !(options.allowHttp ?? process.env.PLAZA_ALLOW_HTTP === '1')) throw new Error('HTTP 只用于短期 IP 测试，须显式设置 PLAZA_ALLOW_HTTP=1；正式使用请配置 HTTPS');
  const spectator = {
    maxStreams: boundedInteger(options.spectatorOptions?.maxStreams ?? process.env.PLAZA_SPECTATOR_MAX_STREAMS, 150, 1, 2000, 'PLAZA_SPECTATOR_MAX_STREAMS'),
    maxPerIp: boundedInteger(options.spectatorOptions?.maxPerIp ?? process.env.PLAZA_SPECTATOR_MAX_PER_IP, 30, 1, 2000, 'PLAZA_SPECTATOR_MAX_PER_IP'),
    maxBufferBytes: boundedInteger(options.spectatorOptions?.maxBufferBytes ?? process.env.PLAZA_SPECTATOR_MAX_BUFFER_BYTES, 262144, 16384, 1048576, 'PLAZA_SPECTATOR_MAX_BUFFER_BYTES'),
  };
  return { mode, host, publicUrl, spectator, secureCookies: mode === 'accounts' && publicUrl.protocol === 'https:' };
}

export function authDatabasePath(dbPath, explicit) {
  return explicit ?? process.env.PLAZA_AUTH_DB ?? (dbPath === ':memory:' ? ':memory:' : resolve(dirname(dbPath), 'auth.sqlite'));
}

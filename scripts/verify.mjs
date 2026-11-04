import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.js')).sort().map(name => `tests/${name}`);
const steps = [
  ['世界与接入测试', ['--test', '--test-concurrency=1', ...tests]],
  ['地图连通性', ['scripts/check-world-maps.mjs']],
  ['浏览器构建', ['node_modules/vite/bin/vite.js', 'build']],
  ['静态传输资源', ['scripts/build-static-transfer.mjs']],
  ['发布包完整性', ['deploy/check-artifacts.mjs']],
  ['真实接入与旁观回归', ['node_modules/@playwright/test/cli.js', 'test', 'v034-world-art', 'v028-home-pixel', 'v033-journey', 'v032-community', 'v031-market', 'v030-ruins', 'v029-world-services', 'homes', 'scenes', 'v027-leisure', 'phaser', 'wilderness', 'motion-polish']],
];
for (const [name, args] of steps) {
  process.stdout.write(`\n验证：${name}\n`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) {
    console.error(`验证停止：${name}`, result.error?.message || `退出码 ${result.status}`);
    process.exit(result.status || 1);
  }
}
console.log('全部验证通过。此命令没有连接生产服务器或执行真实 AI 动作。');

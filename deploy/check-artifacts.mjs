import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const service = read('deploy/ai-plaza.service');
const serverEnv = read('deploy/server.env.example');
const adminEnv = read('deploy/admin.env.example');
const caddy = read('deploy/Caddyfile.example');
const checks = [];
function check(name, test) { assert.ok(test, name); checks.push({ name, status: 'pass' }); }
check('systemd uses a dedicated unprivileged user', /^User=ai-plaza$/m.test(service) && /^Group=ai-plaza$/m.test(service));
check('single production process uses the dedicated Node runtime', /^ExecStart=\/opt\/ai-plaza-node\/bin\/node \/opt\/ai-plaza\/server\/index.js --production$/m.test(service));
check('code is read-only and state directory is persistent', /^ProtectSystem=strict$/m.test(service) && /^ReadWritePaths=\/var\/lib\/ai-plaza$/m.test(service));
check('service reads the documented environment file', /^EnvironmentFile=\/etc\/ai-plaza\/server.env$/m.test(service));
check('remote server template enables account authentication', /^PLAZA_AUTH_MODE=accounts$/m.test(serverEnv));
check('HTTP invitation test requires explicit opt-in and a replaced public URL', /^PLAZA_ALLOW_HTTP=1$/m.test(serverEnv) && /^PLAZA_PUBLIC_URL=http:\/\/REPLACE_WITH_SERVER_IP:3000$/m.test(serverEnv));
check('world and account databases share the backed-up directory', /^PLAZA_DB=\/var\/lib\/ai-plaza\/world.sqlite$/m.test(serverEnv) && /^PLAZA_AUTH_DB=\/var\/lib\/ai-plaza\/auth.sqlite$/m.test(serverEnv));
check('admin credentials are only in a separate placeholder template', !/PLAZA_ADMIN_PASSWORD=/m.test(serverEnv) && /^PLAZA_ADMIN_PASSWORD="REPLACE_WITH_A_UNIQUE_ADMIN_PASSWORD"$/m.test(adminEnv));
check('future TLS proxy targets loopback and supports streaming', /reverse_proxy 127\.0\.0\.1:3000/.test(caddy) && /flush_interval -1/.test(caddy));
check('Node installer pins both supported architectures with SHA-256', /node_version=v22\.23\.4/.test(read('deploy/install-node-debian.sh')) && (read('deploy/install-node-debian.sh').match(/expected_sha=[0-9a-f]{64}/g) || []).length === 2);
check('backup stops the service and restores its previous running state', /systemctl stop ai-plaza\.service/.test(read('deploy/backup.sh')) && /trap restore_service EXIT/.test(read('deploy/backup.sh')));
for (const path of ['server/index.js', 'package-lock.json', 'docs/服务器部署.md']) check(`referenced artifact exists: ${path}`, existsSync(resolve(root, path)));
for (const path of ['deploy/ai-plaza.service', 'deploy/install-node-debian.sh', 'deploy/backup.sh']) check(`Linux configuration has LF line endings: ${path}`, !read(path).includes('\r'));
console.log(JSON.stringify({ status: 'pass', scope: 'Static artifact checks only; not a Linux deployment test.', checks }, null, 2));

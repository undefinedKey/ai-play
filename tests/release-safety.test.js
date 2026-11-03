import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('恢复边界：真实 SQLite、受限归档、完整农田数量与数据库完整性', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['tests/helpers/release-safety.py', '/bin/bash', 'RecoveryDrills.test_restore_and_archive_boundaries', 'RecoveryDrills.test_plot_loss_and_sqlite_integrity_fail_closed'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('生存迁移发布门：缺失helper、子进程失败或缺失成功键均拒绝通过', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['tests/helpers/release-safety.py', '/bin/bash', 'RecoveryDrills.test_survival_verifier_is_required_and_fails_closed'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('家园迁移发布门：家具、展品和留言不能丢失，临时串门不能重启续跑', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['tests/helpers/release-safety.py', '/bin/bash', 'RecoveryDrills.test_home_assets_and_temporary_visits_fail_closed'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Linux 发布故障演练：准备期不停桥、失败恢复代码和SQLite、不确定进程保持桥停', { timeout: 180000, skip: process.platform !== 'linux' ? '发布目标为 Debian；此 Bash/systemd 模拟演练仅在 Linux 执行' : false }, () => {
  assert.ok(existsSync('/bin/bash'), '恢复演练需要 Bash');
  const result = spawnSync('python3', ['tests/helpers/release-safety.py', '/bin/bash', 'RecoveryDrills.test_release_faults'], { encoding: 'utf8', timeout: 175000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('v027 migration preserves books and comments, adds only an unowned rod, and clears temporary fishing', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['tests/helpers/release-safety.py', '/bin/bash', 'RecoveryDrills.test_fishing_defaults_and_existing_books_fail_closed'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('恢复边界：真实 SQLite、受限归档、完整农田数量与数据库完整性', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['tests/helpers/release-safety.py', '/bin/bash', 'RecoveryDrills.test_restore_and_archive_boundaries', 'RecoveryDrills.test_plot_loss_and_sqlite_integrity_fail_closed'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Linux 发布故障演练：准备期不停桥、失败恢复代码和SQLite、不确定进程保持桥停', { timeout: 180000, skip: process.platform !== 'linux' ? '发布目标为 Debian；此 Bash/systemd 模拟演练仅在 Linux 执行' : false }, () => {
  assert.ok(existsSync('/bin/bash'), '恢复演练需要 Bash');
  const result = spawnSync('python3', ['tests/helpers/release-safety.py', '/bin/bash', 'RecoveryDrills.test_release_faults'], { encoding: 'utf8', timeout: 175000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

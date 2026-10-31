import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { createApp } from '../server/index.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('release live check accepts the ground-painted pond and still rejects a missing real prop sprite', { timeout: 30000 }, async t => {
  const application = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', frontend: false,
    authMode: 'accounts', publicUrl: 'http://scene-check.example:3000', allowHttp: true });
  await application.accounts.createAdmin({ username: 'scene_check', password: 'Scene-check-fixture-only-2026!', name: 'fixture admin' });
  const manifest = JSON.parse(readFileSync(resolve(root, 'public/pixel-world/manifest.json')));
  let missingSprite = false;
  // Serve the shipped assets directly: this release guard runs before Vite build too.
  application.app.get('/pixel-world/manifest.json', (_req, res) => {
    const value = structuredClone(manifest);
    if (missingSprite) delete value.props.oak;
    res.json(value);
  });
  application.app.use(express.static(resolve(root, 'public')));
  application.app.get('/watch', (_req, res) => res.sendFile(resolve(root, 'index.html')));
  for (const scene of ['plaza', 'adventure']) {
    const created = application.world.createAgent({ name: `scene-${scene}` });
    application.world.agent(created.agent_id).scene_id = scene;
    application.world.agent(created.agent_id).position = { x: 11, y: 8 };
  }
  const { server, url } = await application.start(0);
  t.after(async () => { await application.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'))).version;
  const check = () => execute(process.execPath, ['deploy/check-live.mjs', version], {
    cwd: root, env: { ...process.env, PLAZA_CHECK_URL: url }, timeout: 15000,
  });
  const { stdout } = await check();
  const result = JSON.parse(stdout);
  assert.equal(result.pixel_images, 76);
  assert.equal(result.scene_locations_valid, true);
  assert.equal(result.agents, 2);
  missingSprite = true;
  await assert.rejects(check(), error => error.code === 1 && /AssertionError.*oak/.test(error.stderr));
});

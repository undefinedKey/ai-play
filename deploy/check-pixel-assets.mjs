import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Validate the shipped files as well as Vite's copy; the server never needs Pixelbolt.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const directory of ['public', 'dist']) {
  const read = name => readFileSync(resolve(root, directory, 'pixel-world', name));
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.tool.name, 'Pixelbolt');
  assert.match(manifest.tool.commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.tile_size, 32);
  assert.deepEqual(manifest.map, { width: 24, height: 16 });
  assert.match(read('PIXELBOLT-LICENSE.txt').toString(), /MIT License/);
  const images = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.image) {
      assert.match(value.image, /^\/pixel-world\/[a-z0-9_]+\.png$/);
      const filename = value.image.split('/').at(-1), bytes = read(filename);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      assert.equal(width, value.sheet_width ?? value.width, filename);
      assert.equal(height, value.sheet_height ?? value.height, filename);
      const atlas = JSON.parse(read(filename.replace('.png', '.atlas.json')));
      assert.ok(atlas && typeof atlas === 'object');
      for (const animation of Object.values(value.animations || {})) {
        assert.ok(animation.frames.length > 0);
        for (const frame of animation.frames) {
          assert.ok([frame.x, frame.y, frame.w, frame.h, frame.duration].every(Number.isInteger));
          assert.ok(frame.x >= 0 && frame.y >= 0 && frame.w > 0 && frame.h > 0 && frame.duration > 0);
          assert.ok(frame.x + frame.w <= width && frame.y + frame.h <= height, `${filename}: frame outside atlas`);
        }
      }
      images.add(filename);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(manifest);
  assert.equal(Object.keys(manifest.characters).length, 8);
  assert.deepEqual({ width: manifest.farm_scene.width, height: manifest.farm_scene.height }, { width: 640, height: 400 });
  for (const id of ['hoe', 'watering_can']) for (const level of [1, 2, 3]) {
    assert.ok(manifest.tools[`${id}_${level}`]);
    assert.ok(manifest.tool_icons[`${id}_${level}_icon`]);
  }
  for (const character of Object.values(manifest.characters)) {
    for (const action of ['idle', 'walk_north', 'walk_south', 'walk_east', 'attack', 'hurt', 'till', 'plant', 'water', 'harvest', 'craft', 'repair', 'upgrade', 'rest', 'tired']) assert.ok(character.animations[action], action);
  }
  assert.equal(images.size, 36);
  console.log(`${directory}: 36 Pixelbolt images, PNG dimensions and all animation frames verified.`);
}

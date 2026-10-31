import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, WORLD_MAP, isWalkable } from '../shared/world-layout.js';

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
      assert.equal(atlas.meta.image,filename);
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
    for (const action of ['idle', 'walk_north', 'walk_south', 'walk_east', 'attack', 'hurt', 'till', 'plant', 'water', 'harvest', 'craft', 'repair', 'upgrade', 'gather', 'cook', 'eat', 'rest', 'tired']) assert.ok(character.animations[action], action);
    assert.equal(character.animations.gather.loop,true);
    assert.equal(character.animations.cook.loop,false);
    assert.equal(character.animations.eat.loop,false);
  }
  for(const id of ['wood','ore','turnip','wheat','turnip_seed','wheat_seed','turnip_soup','wheat_bread','gold'])assert.ok(manifest.items[`item_${id}`]);
  for(const id of ['wood','ore','kitchen','supply'])assert.ok(manifest.landmarks[id]);
  for(const id of ['hunter_bow','heavy_hammer','heavy_armor']){assert.ok(manifest.equipment[id]);for(const action of Object.keys(manifest.characters.wanderer_1.animations))assert.ok(manifest.equipment[id].animations[action]);}
  for(const id of ['supply_cache','wild_garden','spring']){assert.ok(manifest.discoveries[id]);assert.equal(manifest.discoveries[id].animations.resolved.loop,false);}
  assert.equal(manifest.release,'0.18.0');
  for(const scene of SCENES){
    assert.deepEqual(scene.map,WORLD_MAP);
    assert.equal(manifest.scenes[scene.id].width,WORLD_MAP.width*32);
    assert.equal(manifest.scenes[scene.id].height,WORLD_MAP.height*32);
    assert.ok(isWalkable(scene.id,scene.portal.position));
    const other=SCENES.find(s=>s.id===scene.portal.to_scene_id);
    assert.deepEqual(scene.portal.to_position,other.portal.position);
    for(const prop of scene.props){
      if(prop.kind!=='pond'){
        const sprite=manifest.props[prop.kind];assert.ok(sprite,prop.kind);
        assert.deepEqual(sprite.anchor,{x:64,y:120});
        const atlas=JSON.parse(read(sprite.image.split('/').at(-1).replace('.png','.atlas.json')));
        assert.deepEqual(atlas.frames.idle.anchor,sprite.anchor,`${prop.kind} contact anchor differs`);
      }
      assert.ok(prop.position.x>=0&&prop.position.x<WORLD_MAP.width&&prop.position.y>=0&&prop.position.y<WORLD_MAP.height);
      for(const cell of prop.footprint)assert.ok(!isWalkable(scene.id,cell));
    }
    // Flood fill: every legal tile is reachable from its portal.
    const seen=new Set(),todo=[scene.portal.position];
    while(todo.length){const p=todo.pop(),key=`${p.x},${p.y}`;if(seen.has(key)||!isWalkable(scene.id,p))continue;seen.add(key);for(const[dx,dy]of[[0,1],[1,0],[0,-1],[-1,0]])todo.push({x:p.x+dx,y:p.y+dy});}
    assert.equal(seen.size,WORLD_MAP.width*WORLD_MAP.height-scene.blocked.length,`${scene.id} isolated walkable cell`);
  }
  assert.notEqual(read('scene_plaza.png').toString('base64'),read('scene_adventure.png').toString('base64'));
  assert.equal(images.size, 76);
  console.log(`${directory}: 76 Pixelbolt images, frames, scene footprints, portals and reachability verified.`);
}

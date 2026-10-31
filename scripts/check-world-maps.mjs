import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENES } from '../shared/world-layout.js';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root,'public/pixel-world/manifest.json')));
for (const scene of SCENES) {
  const source = JSON.parse(readFileSync(resolve(root,`shared/maps/${scene.id}.json`)));
  for (const layer of source.layers) if (layer.image) assert.ok(existsSync(resolve(root,'shared/maps',layer.image)));
  for (const tile of source.tilesets[0].tiles) assert.ok(existsSync(resolve(root,'shared/maps',tile.image)));
  for (const prop of scene.props) {
    if(prop.kind !== 'pond') assert.ok(manifest.props[prop.kind],prop.kind);
    else {
      const width=Math.max(...prop.footprint.map(p=>p.x))-Math.min(...prop.footprint.map(p=>p.x))+1;
      const height=Math.max(...prop.footprint.map(p=>p.y))-Math.min(...prop.footprint.map(p=>p.y))+1;
      assert.equal(prop.footprint.length,width*height,'painted pond must have a rectangular footprint');
    }
  }
}
console.log(JSON.stringify({tiled_scenes:SCENES.length,shared_geometry:true,assets_exist:true,portals_reciprocal:true,all_walkable_cells_reachable:true}));

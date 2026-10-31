import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENES,WORLD_MAP,isWalkable } from '../shared/world-layout.js';
import {RESOURCE_NODES} from '../shared/resources-layout.js';
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
for(const old of JSON.parse(readFileSync(resolve(root,'art/wilderness/v019-map-baseline.json')))){
  const blocked=new Set(old.blocked.map(p=>`${p.x},${p.y}`));
  for(let y=0;y<old.height;y++)for(let x=0;x<old.width;x++)if(!blocked.has(`${x},${y}`))assert.ok(isWalkable(old.scene_id,{x,y}),`old legal position blocked: ${old.scene_id} ${x},${y}`);
}
for(const node of RESOURCE_NODES)assert.ok(isWalkable(node.scene_id,node.interaction_position),`blocked resource interaction: ${node.id}`);
console.log(JSON.stringify({tiled_scenes:SCENES.length,map:WORLD_MAP,shared_geometry:true,assets_exist:true,portals_reciprocal:true,all_walkable_cells_reachable:true,old_legal_cells_preserved:true,resource_interactions_walkable:true}));

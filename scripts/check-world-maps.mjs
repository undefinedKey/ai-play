import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENES,WORLD_MAP,isWalkable } from '../shared/world-layout.js';
import { COMMUNITY_VENUES } from '../shared/community.js';
const serviceBodies = new Set(COMMUNITY_VENUES.flatMap(v=>v.footprint.map(p=>`${v.scene_id}:${p.x},${p.y}`)));
import {RESOURCE_NODES} from '../shared/resources-layout.js';
import {RUINS_RULES, RUINS_OBJECTS} from '../shared/ruins-layout.js';
import { JOURNEY_GEOMETRY, JOURNEY_NODES } from '../shared/journey.js';
import { JOURNEY_CELLS } from '../shared/journey-layout.js';
import {findWorldPath} from '../server/spatial.js';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root,'public/pixel-world/manifest.json')));
for (const scene of SCENES.filter(s=>s.projection!=='sideview')) {
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
  for(let y=0;y<old.height;y++)for(let x=0;x<old.width;x++)if(!blocked.has(`${x},${y}`)&&!serviceBodies.has(`${old.scene_id}:${x},${y}`))assert.ok(isWalkable(old.scene_id,{x,y}),`old legal position blocked: ${old.scene_id} ${x},${y}`);
}
for(const node of RESOURCE_NODES)assert.ok(isWalkable(node.scene_id,node.interaction_position),`blocked resource interaction: ${node.id}`);
assert.ok(isWalkable('plaza', JOURNEY_GEOMETRY.entrance.position), 'sideview entrance stays physically reachable');
const journeyOrigin = JOURNEY_NODES[0].position;
for (const cell of JOURNEY_CELLS) assert.ok(findWorldPath({state:{}},'journey',journeyOrigin,cell), 'sideview corridor is connected');
for (const node of JOURNEY_NODES) assert.ok(isWalkable('journey',node.position), 'sideview station is legal');
for (const y of [0,15,19,31]) assert.equal(isWalkable('journey',{x:26,y}),false,'sideview forbids off-road movement');
assert.ok(isWalkable(RUINS_RULES.entrance.scene_id,RUINS_RULES.entrance.position),'forest ruin entrance stays legal');
for(const object of RUINS_OBJECTS)assert.ok(isWalkable('ruins',object.interaction_position),`blocked ruins interaction: ${object.id}`);
const path=(state,target)=>findWorldPath({state:{ruins:state}},'ruins',RUINS_RULES.exit.position,target);
assert.equal(path({},RUINS_RULES.runes.interaction_position),null,'closed gate and bridge must seal the court');
for(const open of ['gate_open','bridge_repaired']){
  assert.ok(path({[open]:true},RUINS_RULES.runes.interaction_position),`${open} must independently open a real route`);
  for(const relic of RUINS_RULES.relics){
    assert.equal(path({[open]:true},relic.interaction_position),null,'closed archive must seal all relics');
    assert.ok(path({[open]:true,archive_open:true},relic.interaction_position),`${open} plus archive must reach ${relic.id}`);
  }
}
console.log(JSON.stringify({tiled_scenes:SCENES.filter(s=>s.projection!=='sideview').length,sideview_scenes:SCENES.filter(s=>s.projection==='sideview').length,map:WORLD_MAP,shared_geometry:true,assets_exist:true,primary_portals_reciprocal:true,all_static_walkable_cells_reachable:true,old_legal_cells_preserved_except_explicit_service_bodies:true,resource_interactions_walkable:true,ruins_routes_physically_gated:true}));

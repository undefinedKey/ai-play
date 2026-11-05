import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import plaza from '../shared/maps/plaza.json' with { type:'json' };
import adventure from '../shared/maps/adventure.json' with { type:'json' };
import ruins from '../shared/maps/ruins.json' with { type:'json' };
import { compileWorldMaps,compileTiledScene } from '../shared/tiled-map.js';
import { SCENES,WORLD_MAP,isWalkable } from '../shared/world-layout.js';
import { COMMUNITY_VENUES } from '../shared/community.js';
import { PLAZA_PROPS,PLAZA_SERVICES } from '../shared/plaza-layout.js';
const serviceBodies = new Set(COMMUNITY_VENUES.flatMap(v=>v.footprint.map(p=>`${v.scene_id}:${p.x},${p.y}`)));
const prop = (map,name) => map.layers.find(l=>l.type==='objectgroup').objects.find(o=>o.name===name);
test('non-plaza maps preserve old legal cells while the redesigned plaza blocks exactly its authoritative bodies',()=>{
  assert.deepEqual(compileWorldMaps([ruins,adventure,plaza]),SCENES.filter(s=>s.projection!=='sideview'));
  assert.deepEqual(WORLD_MAP,{width:48,height:32});
  const baseline=JSON.parse(readFileSync(new URL('../art/wilderness/v019-map-baseline.json',import.meta.url)));
  for(const old of baseline.filter(scene=>scene.scene_id!=='plaza')){const blocked=new Set(old.blocked.map(p=>`${p.x},${p.y}`));for(let y=0;y<old.height;y++)for(let x=0;x<old.width;x++)if(!blocked.has(`${x},${y}`)&&!serviceBodies.has(`${old.scene_id}:${x},${y}`))assert.ok(isWalkable(old.scene_id,{x,y}),`${old.scene_id} ${x},${y}`);}
  const bodies=new Set([...PLAZA_PROPS.flatMap(p=>p.footprint),...Object.values(PLAZA_SERVICES).flatMap(s=>s.footprint||[]),...COMMUNITY_VENUES.filter(v=>v.scene_id==='plaza').flatMap(v=>v.footprint)].map(p=>`${p.x},${p.y}`));
  for(let y=0;y<WORLD_MAP.height;y++)for(let x=0;x<WORLD_MAP.width;x++)assert.equal(isWalkable('plaza',{x,y}),!bodies.has(`${x},${y}`),`plaza ${x},${y}`);
  assert.ok(SCENES.filter(s=>s.projection!=='sideview').every(s=>s.props.some(p=>p.position.x>=24)&&s.props.some(p=>p.position.y>=16)));
});
test('editing a sprite moves its collision with its feet; linked arrival gates derive from the other scene',()=>{
  const edited=structuredClone(adventure);prop(edited,'forest_tree_0').x+=32;prop(edited,'portal').x+=32;
  const [village,forest]=compileWorldMaps([plaza,edited,ruins]);
  assert.deepEqual(forest.props.find(p=>p.id==='forest_tree_0').position,{x:2,y:2});
  assert.ok(forest.blocked.some(p=>p.x===2&&p.y===2));assert.ok(!forest.blocked.some(p=>p.x===1&&p.y===2));
  assert.deepEqual(forest.portal.position,{x:12,y:8});assert.deepEqual(village.portal.to_position,{x:12,y:8});
});

test('the generated plaza rejects an independent sprite edit instead of drifting away from service geometry',()=>{
  const edited=structuredClone(plaza);prop(edited,'village_tree_0').x+=32;
  assert.throws(()=>compileWorldMaps([edited,adventure,ruins]),/plaza must match generated portable layout/);
});
test('Tiled class fields survive modern editor saves',()=>{
  const edited=structuredClone(adventure);
  for(const tile of edited.tilesets[0].tiles){tile.class=tile.type;delete tile.type;}
  for(const object of edited.layers[1].objects){object.class=object.type;delete object.type;}
  assert.deepEqual(compileTiledScene(edited),compileTiledScene(adventure));
});
for(const[name,mutate]of[
  ['wrong dimensions',m=>m.width=25],['wrong grid',m=>m.tilewidth=16],['infinite map',m=>m.infinite=true],
  ['fractional foot',m=>prop(m,'cottage').x+=1],['resized sprite',m=>prop(m,'cottage').width=64],
  ['rotated sprite',m=>prop(m,'cottage').rotation=90],['flipped gid',m=>prop(m,'cottage').gid+=2147483648],
  ['external image',m=>m.tilesets[0].tiles[0].image='https://untrusted.example/sprite.png'],
  ['missing portal',m=>m.layers[1].objects=m.layers[1].objects.filter(o=>o.name!=='portal')],
  ['invalid link',m=>m.properties.find(p=>p.name==='destination_scene').value='elsewhere'],
  ['invalid footprint',m=>prop(m,'cottage').properties[0].value='[[999,0]]'],
  ['hidden terrain',m=>m.layers[1].visible=false],['duplicate prop',m=>m.layers[1].objects.push(structuredClone(m.layers[1].objects[0]))],
  ['isolated floor',m=>prop(m,'village_tree_0').properties[0].value='[[0,-1],[0,1],[-1,0],[1,0]]'],
])test(`Tiled validation rejects ${name}`,()=>{const m=structuredClone(plaza);mutate(m);assert.throws(()=>compileWorldMaps([m,adventure,ruins]),/Invalid Tiled world map/);});

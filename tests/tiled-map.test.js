import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import plaza from '../shared/maps/plaza.json' with { type:'json' };
import adventure from '../shared/maps/adventure.json' with { type:'json' };
import { compileWorldMaps,compileTiledScene } from '../shared/tiled-map.js';
import { SCENES,WORLD_MAP,isWalkable } from '../shared/world-layout.js';
const prop = (map,name) => map.layers.find(l=>l.type==='objectgroup').objects.find(o=>o.name===name);
test('expanded Tiled world preserves every old legal cell without relocating residents',()=>{
  assert.deepEqual(compileWorldMaps([adventure,plaza]),SCENES);
  assert.deepEqual(WORLD_MAP,{width:48,height:32});
  const baseline=JSON.parse(readFileSync(new URL('../art/wilderness/v019-map-baseline.json',import.meta.url)));
  for(const old of baseline){const blocked=new Set(old.blocked.map(p=>`${p.x},${p.y}`));for(let y=0;y<old.height;y++)for(let x=0;x<old.width;x++)if(!blocked.has(`${x},${y}`))assert.ok(isWalkable(old.scene_id,{x,y}),`${old.scene_id} ${x},${y}`);}
  assert.ok(SCENES.every(s=>s.props.some(p=>p.position.x>=24)&&s.props.some(p=>p.position.y>=16)));
});
test('editing a sprite moves its collision with its feet; linked arrival gates derive from the other scene',()=>{
  const edited=structuredClone(plaza);prop(edited,'village_tree_0').x+=32;prop(edited,'portal').x+=32;
  const [village,forest]=compileWorldMaps([edited,adventure]);
  assert.deepEqual(village.props.find(p=>p.id==='village_tree_0').position,{x:3,y:19});
  assert.ok(village.blocked.some(p=>p.x===3&&p.y===19));assert.ok(!village.blocked.some(p=>p.x===2&&p.y===19));
  assert.deepEqual(village.portal.position,{x:23,y:8});assert.deepEqual(forest.portal.to_position,{x:23,y:8});
});
test('Tiled class fields survive modern editor saves',()=>{
  const edited=structuredClone(plaza);
  for(const tile of edited.tilesets[0].tiles){tile.class=tile.type;delete tile.type;}
  for(const object of edited.layers[1].objects){object.class=object.type;delete object.type;}
  assert.deepEqual(compileTiledScene(edited),compileTiledScene(plaza));
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
])test(`Tiled validation rejects ${name}`,()=>{const m=structuredClone(plaza);mutate(m);assert.throws(()=>compileWorldMaps([m,adventure]),/Invalid Tiled world map/);});

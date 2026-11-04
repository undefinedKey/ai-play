import { RUINS_RULES } from '../shared/ruins-layout.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {SCENES,WORLD_MAP,isWalkable} from '../shared/world-layout.js';
import {Q_ACTOR_ACTIONS} from '../src/q-actor-art.js';
import {hydrateWardrobeManifest} from '../src/wardrobe-state.js';
import {WARDROBE_CATALOG,WARDROBE_DYES,WARDROBE_HAIRSTYLES} from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';
import {LIFE_RULES} from '../server/life.js';

// Check shipped originals and Vite's copy without an image authoring runtime.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(resolve(root,'package.json'))).version;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const publicManifest=JSON.parse(readFileSync(resolve(root,'public/pixel-world/manifest.json')));
const actions=Q_ACTOR_ACTIONS;
const directions=['south','north','east'];
const rectKey=frame=>[frame.x,frame.y,frame.w,frame.h].join(',');

for(const directory of ['public','dist']){
  const read=name=>readFileSync(resolve(root,directory,'pixel-world',name));
  const manifest=JSON.parse(read('manifest.json'));
  assert.equal(manifest.release,version,`${directory}: stale art release`);
  assert.equal(manifest.render_style,'q-pixel');
  assert.equal(digest(JSON.stringify(manifest)),digest(JSON.stringify(publicManifest)),`${directory}: manifest differs from authored output`);
  hydrateWardrobeManifest(manifest);
  assert.equal(manifest.tile_size,32);
  assert.deepEqual(manifest.map,WORLD_MAP);
  // Keep notices for the legacy authoring pipeline and retained source assets.
  assert.equal(manifest.tool.name,'Original Q World');
  assert.equal(manifest.tool.generator,'scripts/build-q-world.mjs');
  assert.equal(manifest.tool.license,'project-original');
  assert.match(read('PIXELBOLT-LICENSE.txt').toString(),/MIT License/);
  const images=new Map(),definitions=[];
  const collect=(value,path='manifest')=>{
    if(!value||typeof value!=='object')return;
    if(typeof value.image==='string'){
      definitions.push({path,definition:value});return;
    }
    for(const[key,child]of Object.entries(value))collect(child,`${path}.${key}`);
  };
  collect(manifest);
  function texture(image){
    assert.match(image,/^\/pixel-world\/q_[a-z0-9_]+\.png$/);
    if(images.has(image))return images.get(image);
    const filename=image.split('/').at(-1),bytes=read(filename);
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a',filename);
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    assert.ok(width>0&&height>0&&width<=4096&&height<=4096,`${filename}: texture outside supported size`);
    assert.equal(digest(bytes),manifest.texture_sha256?.[filename],`${filename}: PNG differs from the generated Q asset checksum`);
    assert.equal(digest(bytes),digest(readFileSync(resolve(root,'public/pixel-world',filename))),`${filename}: dist/source mismatch`);
    const atlas=JSON.parse(read(filename.replace(/\.png$/,'.atlas.json')));
    assert.equal(atlas.meta.image,filename);
    assert.deepEqual(atlas.meta.size,{w:width,h:height},`${filename}: atlas size differs from PNG`);
    assert.equal(atlas.meta.render_style,'q-pixel',`${filename}: stale atlas style`);
    assert.ok(Object.keys(atlas.frames||{}).length>0,`${filename}: empty atlas`);
    const result={width,height,atlas};images.set(image,result);return result;
  }
  function bounds(frame,image,label){
    assert.ok([frame.x,frame.y,frame.w,frame.h].every(Number.isInteger),`${label}: noninteger source rectangle`);
    assert.ok(frame.x>=0&&frame.y>=0&&frame.w>0&&frame.h>0,`${label}: invalid source rectangle`);
    assert.ok(frame.x+frame.w<=image.width&&frame.y+frame.h<=image.height,`${label}: frame outside source image`);
  }
  function point(value,frame,label){
    assert.ok(value&&Number.isFinite(value.x)&&Number.isFinite(value.y),`${label}: missing source point`);
    assert.ok(value.x>=0&&value.y>=0&&value.x<=frame.w&&value.y<=frame.h,`${label}: point outside source frame`);
    if(value.rotation!==undefined)assert.ok(Number.isFinite(value.rotation),`${label}: invalid rotation`);
  }
  for(const{path,definition:d}of definitions){
    assert.equal(d.render_style,'q-pixel',`${path}: old artwork is still reachable`);
    const base=texture(d.image);
    assert.equal(d.sheet_width??d.width,base.width,`${path}: incorrect source width`);
    assert.equal(d.sheet_height??d.height,base.height,`${path}: incorrect source height`);
    for(const[action,animation]of Object.entries(d.animations||{})){
      assert.ok(animation.frames?.length>0,`${path}.${action}: no frames`);
      for(const frame of animation.frames){
        const label=`${path}.${action}`,source=frame.image||d.image,image=texture(source);
        const width=frame.sheet_width??(frame.image?undefined:d.sheet_width),height=frame.sheet_height??(frame.image?undefined:d.sheet_height);
        assert.equal(width,image.width,`${label}: frame source width`);
        assert.equal(height,image.height,`${label}: frame source height`);
        bounds(frame,image,label);
        assert.ok(Number.isInteger(frame.duration)&&frame.duration>0,`${label}: frame duration`);
        assert.ok(Number.isFinite(frame.native_scale??d.native_scale)&&(frame.native_scale??d.native_scale)>0,`${label}: logical scale`);
        assert.equal(d.anchor_mode,'source',`${label}: anchor must use measured source pixels`);
        point(frame.anchor??d.anchor,frame,`${label}.anchor`);
        for(const[slot,target]of Object.entries(frame.attachments||{}))point(target,frame,`${label}.${slot}`);
        const matches=Object.values(image.atlas.frames).filter(entry=>(entry.image||source)===source&&rectKey(entry.frame)===rectKey(frame));
        assert.ok(matches.length,`${label}: source frame is absent from its atlas`);
      }
    }
  }
  // Named entries may refer to another original sheet for a supplemental pose.
  for(const[image,data]of images)for(const[name,entry]of Object.entries(data.atlas.frames)){
    const actual=texture(entry.image||image);
    bounds(entry.frame,actual,`${image}:${name}`);
    point(entry.anchor||entry.frame.anchor,entry.frame,`${image}:${name}.anchor`);
  }
  const body=manifest.characters.wanderer_1;
  assert.deepEqual(manifest.paper_dolls??{}, {}, `${directory}: historical ink rig must not override a Q character`);
  assert.equal(Object.keys(manifest.characters).length,8);
  for(let i=1;i<=8;i++)assert.ok(manifest.characters[`wanderer_${i}`],`persisted wanderer_${i}`);
  for(const[group,ids]of Object.entries({equipment:['wooden_sword','iron_sword','wooden_shield','iron_armor','hunter_bow','heavy_hammer','heavy_armor'],accessories:['leaf','scarf','ribbon','star']}))for(const id of ids)assert.ok(manifest[group]?.[id],`${group}.${id}`);
  for(const id of ['hoe','watering_can','axe','pickaxe','fishing_rod'])for(const level of [1,2,3]){
    assert.ok(manifest.tools[`${id}_${level}`]);assert.ok(manifest.tool_icons[`${id}_${level}_icon`]);
  }
  for(const item of WARDROBE_CATALOG)for(const dye of WARDROBE_DYES)assert.ok(manifest.wardrobe?.[`${item.id}_${dye.id}`],`missing garment ${item.id}/${dye.id}`);
  for(let i=1;i<=8;i++){
    const id=`wanderer_${i}`;assert.ok(manifest.characters_no_hair?.[id]);assert.ok(manifest.wardrobe_hands?.[id]);
    for(const hair of WARDROBE_HAIRSTYLES.filter(row=>row.id!=='original'))assert.ok(manifest.hairstyles?.[`hair_${hair.id}_${id}`]);
  }
  for(const id of ['wanderer_2','wanderer_8'])assert.ok(manifest.characters_no_hat?.[id]);
  const dressedGroups=['wardrobe','hairstyles','characters_no_hat','characters_no_hair','wardrobe_hands'];
  for(const group of ['characters','equipment','accessories','tools',...dressedGroups])for(const[id,sprite]of Object.entries(manifest[group]))for(const action of actions){
    assert.ok(sprite.animations[action],`${group}.${id}.${action}`);
    for(const direction of directions){
      const key=`${action}_${direction}`,animation=sprite.animations[key],baseline=body.animations[key];
      assert.ok(animation,`${group}.${id}.${key}`);
      assert.equal(animation.frames.length,4,`${group}.${id}.${key}: four action phases`);
      assert.deepEqual(animation.frames.map(frame=>frame.duration),baseline.frames.map(frame=>frame.duration),`${group}.${id}.${key}: layer timing differs`);
      assert.equal(animation.loop,baseline.loop,`${group}.${id}.${key}: layer looping differs`);
      if(group==='characters')for(const frame of animation.frames)for(const slot of ['hand','head','chest'])point(frame.attachments?.[slot],frame,`${id}.${key}.${slot}`);
    }
  }
  for(const character of Object.values(manifest.characters)){
    assert.equal(character.animations.gather.loop,true);
    for(const action of ['attack','hurt','cook','eat'])assert.equal(character.animations[action].loop,false);
    assert.notDeepEqual(character.animations.walk.frames,character.animations.run.frames);
    assert.notDeepEqual(character.animations.attack_north.frames,character.animations.attack_south.frames);
  }
  for(const group of ['equipment','accessories','tools',...dressedGroups])for(const sprite of Object.values(manifest[group])){
    assert.equal(sprite.overlay_mode,'registered-canvas',`${group}: unregistered Q layer`);
    assert.equal(sprite.native_scale,1);assert.deepEqual(sprite.anchor,{x:24,y:43});
    for(const animation of Object.values(sprite.animations))for(const frame of animation.frames){assert.equal(frame.w,48);assert.equal(frame.h,48);assert.deepEqual(frame.anchor??sprite.anchor,{x:24,y:43});}
  }
  for(const id of ['forest_slime','forest_boar','ruins_guardian']){
    const monster=manifest.monsters[id];assert.ok(monster,id);
    // Monsters have their own weight and cadence. Directions of one species
    // must agree, while worn items above still follow the human body exactly.
    for(const action of actions.slice(0,5))for(const direction of directions){const animation=monster.animations[`${action}_${direction}`],baseline=monster.animations[`${action}_south`];assert.equal(animation.frames.length,4);assert.deepEqual(animation.frames.map(f=>f.duration),baseline.frames.map(f=>f.duration));}
  }
  for(const item of LIFE_RULES.items)assert.ok(manifest.items[`item_${item.id}`]||manifest.tool_icons[`${item.id}_1_icon`]||manifest.equipment[item.id],`real catalog ${item.id} must have current artwork`);
  for(const id of ['wood','ore','turnip','wheat','turnip_seed','wheat_seed','turnip_soup','wheat_bread','gold','berry','moon_herb','trail_ration','moon_stew','grass','pine_cone','torch','roasted_berry'])assert.ok(manifest.items[`item_${id}`]);
  for(const id of ['wood','ore','kitchen','supply'])assert.ok(manifest.landmarks[id]);
  for(const id of ['supply_cache','wild_garden','spring'])assert.equal(manifest.discoveries[id].animations.resolved.loop,false);
  assert.ok(manifest.farm_scene?.image);
  for(const id of ['turnip','wheat'])for(const stage of ['untilled','tilled','seeded','growing','ready'])assert.ok(manifest.crops[id].animations[stage]?.frames.length,`${id}.${stage}`);
  for(const id of ['campfire','campfire_ashes'])assert.ok(manifest.effects[id]?.animations.idle.frames.length,id);
  assert.notDeepEqual(manifest.effects.campfire.animations.idle.frames,manifest.effects.campfire_ashes.animations.idle.frames);
  for(const scene of SCENES.filter(s=>s.projection!=='sideview')){
    assert.deepEqual(scene.map,WORLD_MAP);
    assert.equal(manifest.scenes[scene.id].width,WORLD_MAP.width*32);
    assert.equal(manifest.scenes[scene.id].height,WORLD_MAP.height*32);
    assert.ok(isWalkable(scene.id,scene.portal.position));
    const other=SCENES.find(s=>s.id===scene.portal.to_scene_id);
    assert.deepEqual(scene.portal.to_position,scene.id === 'ruins' ? RUINS_RULES.entrance.position : other.portal.position);
    for(const prop of scene.props){
      if(prop.kind!=='pond'){
        const sprite=manifest.props[prop.kind];assert.ok(sprite,prop.kind);
        const frame=sprite.animations.idle.frames[0],image=texture(frame.image||sprite.image),anchor=frame.anchor||sprite.anchor;
        const matches=Object.values(image.atlas.frames).filter(entry=>rectKey(entry.frame)===rectKey(frame));
        assert.ok(matches.some(entry=>entry.anchor.x===anchor.x&&entry.anchor.y===anchor.y),`${prop.kind}: contact anchor differs from authored source`);
      }
      assert.ok(prop.position.x>=0&&prop.position.x<WORLD_MAP.width&&prop.position.y>=0&&prop.position.y<WORLD_MAP.height);
      for(const cell of prop.footprint)assert.ok(!isWalkable(scene.id,cell));
    }
    // Every legal tile must remain reachable from its portal.
    const seen=new Set(),todo=[scene.portal.position];
    while(todo.length){const p=todo.pop(),key=`${p.x},${p.y}`;if(seen.has(key)||!isWalkable(scene.id,p))continue;seen.add(key);for(const[dx,dy]of [[0,1],[1,0],[0,-1],[-1,0]])todo.push({x:p.x+dx,y:p.y+dy});}
    assert.equal(seen.size,WORLD_MAP.width*WORLD_MAP.height-scene.blocked.length,`${scene.id}: isolated walkable cell`);
  }
  for(const id of ['pine','oak','ore','berries','stump','herb','tree_sapling','tree_young','tree_mature','tree_stump']){
    const asset=manifest.wilderness[id];assert.ok(asset?.native_scale>0&&asset.native_scale<=1,id);
    point(asset.anchor,asset.animations.idle.frames[0],`${id}.anchor`);
  }
  console.log(`${directory}: ${images.size} native Q pixel textures, source frames, action attachments, scene footprints, portals and reachability verified.`);
}

// Historical ink renderer coverage; active Q art is covered by v034 tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';

// Release guards for the shipped originals and their sampling metadata. These
// checks cannot judge drawing quality, pose readability or scene composition;
// the real screenshot matrix in V022-ART-DIRECTION.md remains a separate gate.
const root=resolve(import.meta.dirname,'..');
const manifest=JSON.parse(readFileSync(resolve(root,'art/ink-world/v033-manifest.json')));
const groupIds={
  characters:Array.from({length:8},(_,i)=>`wanderer_${i+1}`),
  monsters:['forest_slime','forest_boar','ruins_guardian'],
  props:['bookshop','cottage','shed','game_table','oak','birch','apple','well','bench','portal_plaza','pine','pine_tall','dead_tree','ruin_arch','ruin_column','ruin_wall','rock','rock_large','portal_adventure'],
  equipment:['wooden_sword','iron_sword','wooden_shield','iron_armor','hunter_bow','heavy_hammer','heavy_armor'],
  accessories:['leaf','scarf','ribbon','star'],
  tools:['hoe','watering_can','axe','pickaxe'].flatMap(id=>[1,2,3].map(level=>`${id}_${level}`)),
  tool_icons:['hoe','watering_can','axe','pickaxe'].flatMap(id=>[1,2,3].map(level=>`${id}_${level}_icon`)),
  items:['wood','ore','turnip','wheat','turnip_seed','wheat_seed','turnip_soup','wheat_bread','gold','berry','moon_herb','trail_ration','moon_stew','grass','pine_cone','torch','roasted_berry'].map(id=>`item_${id}`),
  landmarks:['wood','ore','kitchen','supply'],
  discoveries:['supply_cache','wild_garden','spring'],
  effects:['campfire','campfire_ashes'],
  crops:['turnip','wheat'],
  wilderness:['pine','oak','ore','berries','stump','herb','tree_sapling','tree_young','tree_mature','tree_stump'],
};
const definitions=[];
function collect(value,path='manifest'){
  if(!value||typeof value!=='object')return;
  if(typeof value.image==='string'){definitions.push({path,definition:value});return;}
  for(const[key,child]of Object.entries(value))collect(child,`${path}.${key}`);
}
collect(manifest);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const cache=new Map();

// Decode only the 8-bit RGB/RGBA source formats used by this release. Reading
// alpha, rather than the preview background, detects fake opaque sprite sheets.
function png(bytes,label){
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a',`${label}: PNG signature`);
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.ok(width>0&&height>0&&width<=4096&&height<=4096,`${label}: texture must fit 4096×4096`);
  assert.equal(bytes[24],8,`${label}: expected 8-bit source`);
  const channels=bytes[25]===6?4:bytes[25]===2?3:0;
  assert.ok(channels,`${label}: expected RGB or RGBA source`);
  assert.equal(bytes[28],0,`${label}: unexpected interlaced source`);
  const chunks=[];
  for(let offset=8;offset<bytes.length;){
    assert.ok(offset+12<=bytes.length,`${label}: truncated PNG chunk`);
    const length=bytes.readUInt32BE(offset),end=offset+12+length;
    assert.ok(end<=bytes.length,`${label}: truncated PNG data`);
    const type=bytes.toString('ascii',offset+4,offset+8);
    if(type==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+length));
    offset=end;
    if(type==='IEND')break;
  }
  const stride=width*channels,expected=(stride+1)*height;
  const raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:expected});
  assert.equal(raw.length,expected,`${label}: decoded dimensions`);
  const pixels=Buffer.alloc(stride*height);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)],row=y*stride;
    assert.ok(filter<=4,`${label}: unsupported PNG filter`);
    for(let x=0;x<stride;x++){
      const left=x>=channels?pixels[row+x-channels]:0,up=y?pixels[row+x-stride]:0,corner=y&&x>=channels?pixels[row+x-stride-channels]:0;
      const prediction=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner);
      pixels[row+x]=(raw[y*(stride+1)+x+1]+prediction)&255;
    }
  }
  return{width,height,channels,pixels,alphaAt:(x,y)=>channels===4?pixels[(y*width+x)*4+3]:255};
}
function shipped(image){
  assert.match(image,/^\/pixel-world\/[a-z0-9_]+\.png$/);
  if(!cache.has(image)){
    const bytes=readFileSync(resolve(root,'public',image.slice(1)));
    cache.set(image,{bytes,...png(bytes,image)});
  }
  return cache.get(image);
}

test('ink release covers every reachable art group and preserves persisted appearance and item IDs',()=>{
  assert.equal(manifest.render_style,'ink');
  for(const[group,ids]of Object.entries(groupIds))for(const id of ids){
    assert.ok(manifest[group]?.[id]?.image,`${group}.${id} is missing`);
  }
  assert.equal(Object.keys(manifest.characters).length,8);
  for(const key of ['scene','farm_scene'])assert.ok(manifest[key]?.image,`${key} is missing`);
  for(const id of ['plaza','adventure'])assert.ok(manifest.scenes?.[id]?.image,`scenes.${id} is missing`);
  const remainingPixel=definitions.filter(({definition})=>definition.render_style!=='ink').map(({path})=>path);
  assert.deepEqual(remainingPixel,[],'A reachable image still uses legacy artwork; a root style flag is insufficient');
});

test('published ink textures are byte-for-byte originals with correct dimensions and bounded GPU size',()=>{
  const sourceDir=resolve(root,'art/ink-world');
  const originalHashes=new Set(readdirSync(sourceDir).filter(name=>extname(name)==='.png').map(name=>hash(readFileSync(resolve(sourceDir,name)))));
  assert.ok(originalHashes.size>=3,'original art sheets must be included in the repository');
  const checked=new Set();
  for(const{path,definition:d}of definitions){
    const sources=[{image:d.image,width:d.sheet_width??d.width,height:d.sheet_height??d.height},...Object.values(d.animations||{}).flatMap(animation=>animation.frames.filter(frame=>frame.image).map(frame=>({image:frame.image,width:frame.sheet_width,height:frame.sheet_height})))];
    for(const source of sources){
      const image=shipped(source.image);
      assert.equal(source.width,image.width,`${path}: sheet width differs from source`);
      assert.equal(source.height,image.height,`${path}: sheet height differs from source`);
      if(checked.has(source.image))continue;
      checked.add(source.image);
      assert.ok(originalHashes.has(hash(image.bytes)),`${source.image}: published PNG is not an unchanged ink original`);
      const atlas=JSON.parse(readFileSync(resolve(root,'public',source.image.slice(1).replace(/\.png$/,'.atlas.json'))));
      assert.equal(atlas.meta.image,source.image.split('/').at(-1),`${source.image}: atlas image reference`);
      assert.deepEqual(atlas.meta.size,{w:image.width,h:image.height},`${source.image}: atlas dimensions`);
    }
  }
});

test('ink sprite frames sample valid nonempty source rectangles and retain transparent gutters',()=>{
  const checkedAlpha=new Set(),checkedFrames=new Set();
  for(const{path,definition:d}of definitions){
    if(!d.animations)continue; // Whole scene backgrounds are intentionally opaque.
    const validateAlpha=(source,image)=>{
      assert.equal(image.channels,4,`${path}: sprite sheet needs real alpha`);
      if(checkedAlpha.has(source))return;
      checkedAlpha.add(source);
      let transparent=0,solid=0;
      for(let i=3;i<image.pixels.length;i+=4){const a=image.pixels[i];if(a===0)transparent++;if(a>=200)solid++;}
      assert.ok(transparent>image.width*image.height*.05,`${source}: sprite gutters are opaque`);
      // Imagegen originals may peak at 254; full alpha 255 is not required.
      assert.ok(solid>0,`${source}: sprite content is absent or faint`);
    };
    validateAlpha(d.image,shipped(d.image));
    assert.ok(Object.keys(d.animations).length>0,`${path}: no animations`);
    for(const[action,animation]of Object.entries(d.animations)){
      assert.ok(animation.frames?.length>0,`${path}.${action}: empty animation`);
      for(const frame of animation.frames){
        const label=`${path}.${action}`,source=frame.image||d.image,image=shipped(source);
        validateAlpha(source,image);
        const scale=frame.native_scale??d.native_scale;
        assert.ok(Number.isFinite(scale)&&scale>0,`${label}: missing logical scale`);
        assert.equal(frame.sheet_width??d.sheet_width,image.width,`${label}: frame source width`);
        assert.equal(frame.sheet_height??d.sheet_height,image.height,`${label}: frame source height`);
        assert.ok([frame.x,frame.y,frame.w,frame.h,frame.duration].every(Number.isInteger),`${label}: noninteger sampling metadata`);
        assert.ok(frame.x>=0&&frame.y>=0&&frame.w>0&&frame.h>0&&frame.duration>0,`${label}: invalid frame`);
        assert.ok(frame.x+frame.w<=image.width&&frame.y+frame.h<=image.height,`${label}: frame outside image`);
        const anchor=frame.anchor??(d.anchor_mode==='source'?d.anchor:null);
        assert.ok(anchor&&Number.isFinite(anchor.x)&&Number.isFinite(anchor.y),`${label}: missing measured source anchor`);
        const key=`${source}:${frame.x},${frame.y},${frame.w},${frame.h}`;
        if(checkedFrames.has(key))continue;
        checkedFrames.add(key);
        let visible=false;
        for(let y=frame.y;y<frame.y+frame.h&&!visible;y++)for(let x=frame.x;x<frame.x+frame.w;x++)if(image.alphaAt(x,y)>=200){visible=true;break;}
        assert.ok(visible,`${label}: frame selects only transparent space`);
      }
    }
  }
});

test('ink art still distinguishes confirmed actions, directions and true crop/fire stages',()=>{
  const actions=['idle','walk','run','attack','hurt','till','plant','water','harvest','craft','repair','upgrade','gather','cook','eat','rest','tired'];
  for(const[id,body]of Object.entries(manifest.characters)){
    for(const action of actions)for(const direction of ['south','north','east'])assert.ok(body.animations[`${action}_${direction}`]?.frames?.length,`${id}: ${action}_${direction}`);
    assert.notDeepEqual(body.animations.walk.frames,body.animations.run.frames,`${id}: walk and run must remain distinct`);
    assert.notDeepEqual(body.animations.attack_north.frames,body.animations.attack_south.frames,`${id}: front and back attacks must remain distinct`);
    assert.equal(body.animations.attack.loop,false,`${id}: attack must stop with its receipt`);
    assert.equal(body.animations.gather.loop,true,`${id}: active gathering is continuous`);
    for(const action of ['cook','eat'])assert.equal(body.animations[action].loop,false,`${id}: ${action} is receipt-bound`);
  }
  for(const[id,crop]of Object.entries(manifest.crops))for(const state of ['untilled','tilled','seeded','growing','ready'])assert.ok(crop.animations[state]?.frames?.length,`${id}: ${state}`);
  for(const[id,discovery]of Object.entries(manifest.discoveries))assert.equal(discovery.animations.resolved.loop,false,`${id}: discovery completion`);
  const fire=manifest.effects.campfire,ashes=manifest.effects.campfire_ashes;
  assert.ok(ashes?.animations?.idle?.frames?.length,'extinguished fire needs its own source frame');
  assert.notDeepEqual({image:fire.image,frames:fire.animations.idle.frames},{image:ashes.image,frames:ashes.animations.idle.frames},'extinguished fire must not keep a burning texture');
});

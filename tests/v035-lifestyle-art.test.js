import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WARDROBE_CATALOG, WARDROBE_DYES, WARDROBE_HAIRSTYLES } from '../skills/ai-plaza/scripts/lifestyle-contract.mjs';
import { qActorPose, Q_ACTOR_ACTIONS, Q_DIRECTIONS, qCharacterPixels } from '../src/q-actor-art.js';
import { journeyCharacterPixels, journeyIdentity } from '../src/journey-pixel-art.js';
import { wardrobeGarmentPixels, wardrobeHairPixels, wardrobeForegroundPixels, WARDROBE_PIXEL_DYES } from '../src/wardrobe-pixel-art.js';
import { visibleWardrobe, wardrobeLayerKeys, hydrateWardrobeManifest, wardrobeDescription } from '../src/wardrobe-state.js';
import { publicAquarium, aquariumGeometry, aquariumFishPixels, aquariumDecorationPixels, aquariumFishTrack } from '../src/aquarium-art.js';
import { homeFurniturePixels } from '../src/home-pixel-drawing.js';
import { HOME_PIXEL_ART } from '../src/home-pixel-manifest.js';
import { homeFurnitureLayout, homeFurnitureFootprint } from '../src/home-pixel-layout.js';

const garment=(style_id,color_id='natural')=>({garment_id:`g_${style_id}`,style_id,color_id,created_at:1});
const actor={agent_id:'persistent-original',appearance:{sprite_id:'wanderer_2',seed:'persistent-original',accessory_id:'leaf'},life:{equipment:{armor:'iron_armor',weapon:'iron_sword'},gathering:{tool_id:'pickaxe'}}};
function validPixels(pixels,width=48,height=48){for(const p of pixels){assert.ok([p.x,p.y,p.w,p.h].every(Number.isInteger),JSON.stringify(p));assert.ok(p.x>=0&&p.y>=0&&p.w>0&&p.h>0&&p.x+p.w<=width&&p.y+p.h<=height,JSON.stringify(p));assert.match(p.color,/^#[0-9a-f]{6}$/i);}}
function validDrawing(d){validPixels(d.rects.map(p=>({x:p.x,y:p.y,w:p.width,h:p.height,color:p.fill})),d.width,d.height);}

test('public wardrobe consumes only valid current slots, keeps identity, and returns to exact original selection',()=>{
  const original=JSON.stringify(actor);
  assert.deepEqual(wardrobeDescription(actor),[]);
  assert.equal(wardrobeLayerKeys(actor).bodyGroup,'characters');
  const dressed={...actor,wardrobe:{hairstyle:'bob',wearing:{outfit:garment('garden_apron','leaf'),head:garment('straw_hat','sky'),back:garment('travel_pack','rose')},collection:[garment('traveler_coat','ochre')]}};
  assert.equal(wardrobeLayerKeys(dressed).bodyGroup,'characters_no_hair');assert.equal(wardrobeLayerKeys(dressed).hair,'hair_bob_wanderer_2');
  assert.equal(wardrobeDescription(dressed).length,4);assert.ok(!wardrobeDescription(dressed).join(' ').includes('旅行外套'));
  assert.equal(visibleWardrobe({...actor,wardrobe:{hairstyle:'invented',wearing:{outfit:garment('straw_hat'),head:garment('soft_cap','missing')}}}).hairstyle,'original');
  assert.equal(visibleWardrobe({...actor,wardrobe:{wearing:{outfit:garment('straw_hat')}}}).wearing.outfit,null);
  assert.deepEqual(wardrobeLayerKeys({...dressed,wardrobe:{hairstyle:'original',wearing:{outfit:null,head:null,back:null}}}),wardrobeLayerKeys(actor));
  assert.equal(JSON.stringify(actor),original);
});

test('every garment and dye has native geometry throughout all original actor action phases',()=>{
  for(const item of WARDROBE_CATALOG)for(const dye of WARDROBE_DYES){
    assert.equal(WARDROBE_PIXEL_DYES[dye.id][0],dye.color);
    for(const action of Q_ACTOR_ACTIONS)for(const direction of Q_DIRECTIONS)for(let frame=0;frame<4;frame++){
      const pixels=wardrobeGarmentPixels(item.id,dye.id,qActorPose(action,direction,frame));validPixels(pixels);
      if(action!=='sleep'||item.slot!=='back')assert.ok(pixels.length,`${item.id}/${action}/${direction}`);
    }
    const idle=wardrobeGarmentPixels(item.id,dye.id,qActorPose('idle','south',0));
    assert.ok(idle.some(p=>p.color===dye.color),`${item.id}/${dye.id} must actually change pixels`);
  }
  const silhouettes=WARDROBE_CATALOG.map(item=>JSON.stringify(wardrobeGarmentPixels(item.id,'natural',qActorPose('idle','south',0))));
  assert.equal(new Set(silhouettes).size,7);
  for(const style of WARDROBE_HAIRSTYLES.filter(row=>row.id!=='original'))for(let i=1;i<=8;i++){
    const identity=journeyIdentity({agent_id:`wanderer_${i}`,appearance:{sprite_id:`wanderer_${i}`,seed:`wanderer_${i}`}});
    for(const action of Q_ACTOR_ACTIONS)for(const direction of Q_DIRECTIONS)for(let frame=0;frame<4;frame++)validPixels(wardrobeHairPixels(style.id,identity,qActorPose(action,direction,frame)));
    assert.ok(wardrobeHairPixels(style.id,identity,qActorPose('idle','south',0)).some(p=>p.color===identity.hair));
  }
});

test('journey wear is visible in the actual drawing and leaves original face, combat gear and tools unchanged',()=>{
  for(const action of ['idle','walk','run','attack','hurt','gather','eat','rest'])for(let frame=0;frame<4;frame++){
    const state={action,frame,itemId:'berry'},base=journeyCharacterPixels(actor,state);
    const dressed={...actor,wardrobe:{hairstyle:'ponytail',wearing:{outfit:garment('traveler_coat','sky'),head:garment('soft_cap','rose'),back:garment('travel_pack','leaf')}}};
    const pixels=journeyCharacterPixels(dressed,state);validPixels(pixels);assert.notDeepEqual(base,pixels);
    assert.ok(pixels.some(p=>p.part==='wardrobe-head'));assert.ok(pixels.some(p=>p.part==='wardrobe-hair'));
    const essential=p=>['face','eyes','tool','food','armor-iron'].includes(p.part);
    assert.deepEqual(pixels.filter(essential),base.filter(essential));
    assert.deepEqual(journeyCharacterPixels({...dressed,wardrobe:{hairstyle:'original',wearing:{}}},state),base);
  }
});

test('original book and pen stay in front of worn outfits during every seated and standing reading/writing pose',()=>{
  const id='wanderer_2',identity=journeyIdentity({agent_id:id,appearance:{sprite_id:id,seed:id}});
  for(const action of ['read','write','stand_read','stand_write'])for(const direction of Q_DIRECTIONS)for(let frame=0;frame<4;frame++){
    const state={action,direction,frame},body=qCharacterPixels(id,state),front=wardrobeForegroundPixels(identity,qActorPose(action,direction,frame),body);
    validPixels(front);
    assert.deepEqual(front.filter(p=>['book','pen'].includes(p.part)),body.filter(p=>['book','pen'].includes(p.part)));
    if(direction!=='north')assert.ok(front.some(p=>p.part==='book'));
    if(direction!=='north'&&action.includes('write'))assert.ok(front.some(p=>p.part==='pen'));
  }
});

test('wardrobe animation reuse is bounded to the original atlas and rejects reference or geometry corruption',()=>{
  const raw=JSON.parse(readFileSync(new URL('../public/pixel-world/manifest.json',import.meta.url)));
  const body=raw.characters.wanderer_1,{animations,...geometry}=body;
  const make=()=>({characters:{wanderer_1:body},wardrobe:{sample:{...geometry,animation_template:'characters.wanderer_1'}}});
  assert.equal(hydrateWardrobeManifest(make()).wardrobe.sample.animations,animations);
  for(const patch of [{animation_template:'wardrobe.other'},{width:96},{sheet_height:1},{anchor:{x:0,y:0}},{overlay_mode:'free'}]){
    const manifest=make();Object.assign(manifest.wardrobe.sample,patch);assert.throws(()=>hydrateWardrobeManifest(manifest));
  }
  const cycle=make();cycle.characters={wanderer_1:{...body,animation_template:'wardrobe.sample'}};assert.throws(()=>hydrateWardrobeManifest(cycle));
  if(raw.wardrobe){
    hydrateWardrobeManifest(raw);
    for(const item of WARDROBE_CATALOG)for(const dye of WARDROBE_DYES)assert.equal(raw.wardrobe[`${item.id}_${dye.id}`].animations,raw.characters.wanderer_1.animations);
  }
});

test('aquarium is four authored tank views using its real rotated footprint; fish and decoration paths stay inside glass',()=>{
  const views=[];
  for(const rotation of [0,90,180,270]){
    const item={kind:'aquarium',x:3,y:4,rotation},geometry=aquariumGeometry(rotation),art=HOME_PIXEL_ART.aquarium.variants[rotation];
    const drawing=homeFurniturePixels('aquarium',rotation);validDrawing(drawing);views.push(JSON.stringify(drawing));
    assert.equal(art.width,geometry.width);assert.equal(art.height,geometry.height);
    assert.deepEqual(homeFurnitureFootprint(item),[90,270].includes(rotation)?[1,2]:[2,1]);
    const layout=homeFurnitureLayout(item,undefined,HOME_PIXEL_ART.aquarium);assert.equal(layout.y+art.anchor.y,layout.foot.y);
    for(let i=0;i<4;i++){
      const t=aquariumFishTrack({fish_id:`real_${i}`},i,rotation),water=geometry.water;
      assert.ok(t.x>=water.x&&t.y>=water.y);assert.ok(t.x+t.travel+13<=water.x+water.width);assert.ok(t.y+9<=water.y+water.height);
    }
  }
  assert.equal(new Set(views).size,4);
  for(const species of ['pond_fish','silver_fish'])validDrawing(aquariumFishPixels(species));
  assert.notDeepEqual(aquariumFishPixels('pond_fish'),aquariumFishPixels('silver_fish'));
  for(const kind of ['water_grass','pebbles','driftwood'])validDrawing(aquariumDecorationPixels(kind));
});

test('an empty or stored aquarium never invents fish; only saved public contents and names are shown',()=>{
  assert.deepEqual(publicAquarium({kind:'aquarium'}),{fish:[],decorations:[]});
  const item={kind:'aquarium',instance_id:'tank',aquarium:{fish:[{fish_id:'unique',item_id:'silver_fish',name:'小闪'},{fish_id:'fake',item_id:'grilled_fish'}],decorations:[{slot:2,decoration_id:'water_grass'},{slot:4,decoration_id:'driftwood'}]}};
  const saved=JSON.stringify(item),data=publicAquarium(item);assert.equal(data.fish.length,1);assert.equal(data.fish[0].name,'小闪');assert.equal(data.fish[0].species,'银鳞鱼');assert.equal(data.decorations[0].slot,2);
  assert.deepEqual(publicAquarium({kind:'chair',aquarium:item.aquarium}),{fish:[],decorations:[]});assert.equal(JSON.stringify(item),saved);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {LIFE_RULES} from '../server/life.js';
import {RUINS_ITEMS} from '../shared/ruins-layout.js';

const root=resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await readFile(resolve(root,'public/pixel-world/manifest.json')));
const visual=id=>manifest.items[`item_${id}`]||manifest.tool_icons[`${id}_1_icon`]||manifest.equipment[id];
async function pixels(definition,state='idle'){
  const f=definition.animations[state].frames[0];
  return sharp(resolve(root,'public'+definition.image)).extract({left:f.x,top:f.y,width:f.w,height:f.h}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
}

test('v034 every real inventory, recipe, ingredient and relic resolves to nonempty native pixel art',async()=>{
  const ids=new Set([...LIFE_RULES.items.map(item=>item.id),...RUINS_ITEMS.map(item=>item.id),...LIFE_RULES.recipes.flatMap(recipe=>[recipe.item_id,...Object.keys(recipe.ingredients)]),'gold']);
  for(const id of ids){
    const definition=visual(id);assert.ok(definition,`Missing currently usable catalog item: ${id}`);
    assert.equal(definition.render_style,'q-pixel');assert.match(definition.image,/\/q_[a-z0-9_]+\.png$/);
    const {data}=await pixels(definition);assert.ok(data.some((value,index)=>index%4===3&&value===255),`${id} is transparent`);
  }
  const fish=await Promise.all(['pond_fish','silver_fish','grilled_fish','fish_bait'].map(async id=>(await pixels(visual(id))).data.toString('hex')));
  assert.equal(new Set(fish).size,4,'raw fish, silver fish, cooked fish and bait retain distinct factual appearances');
});

test('v034 farm-only crop sheets retain readable whole soil cells and distinct actual stages',async()=>{
  for(const id of ['turnip','wheat']){
    const states=[];
    for(const state of ['untilled','tilled','seeded','growing','ready']){
      const {data,info}=await pixels(manifest.crops[id],state);states.push(data.toString('hex'));
      let soil=0;for(let y=27;y<44;y++)for(let x=3;x<51;x++)if(data[(y*info.width+x)*4+3]===255)soil++;
      assert.ok(soil>=700,`${id}/${state} needs a complete bed rather than isolated tiny patches`);
    }
    assert.equal(new Set(states).size,5,`${id}: a clock must not visually replace a different authoritative crop state`);
  }
});

import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {applyInkFarmEffects} from './farm-effects.mjs';
import {applyInkInventory} from './inventory.mjs';
import {applyInkActors} from './actors.mjs';
import {applyFeiyuPaperDoll} from './paper-doll.mjs';

// Original imagegen sheets are copied byte-for-byte. Only measured rectangular
// source frames and their actual contact points are described here.
// Rectangles use [left, top, right, bottom], contact points are sheet coordinates.
export const environmentFrames={
  pine:[[54,0,362,408],[210,400],.24],
  oak:[[408,8,788,408],[596,400],.25],
  ore:[[810,130,1145,410],[977,401],.23],
  berries:[[1190,98,1515,410],[1350,400],.19],
  stump:[[34,428,398,716],[213,704],.14],
  herb:[[499,424,738,697],[618,688],.13],
  grass:[[854,429,1090,695],[970,687],.12],
  branches:[[1211,491,1499,695],[1350,686],.105],
  stones:[[48,830,373,1000],[211,987],.12],
  tree_sapling:[[509,774,694,1006],[602,996],.18],
  tree_young:[[879,708,1070,1009],[974,999],.22],
  dead_tree:[[1234,698,1499,1014],[1364,1004],.25],
};
export const buildingFrames={
  bookshop:[[42,0,343,384],[192,373],.28],
  cottage:[[406,5,774,385],[587,374],.29],
  shed:[[794,124,1195,376],[992,366],.24],
  well:[[1222,39,1494,381],[1358,371],.22],
  game_table:[[400,472,768,698],[582,687],.21],
  portal:[[789,386,1167,688],[977,677],.25],
  ruin_arch:[[1184,394,1522,698],[1354,687],.25],
  ruin_column:[[20,678,311,1014],[166,1003],.23],
  ruin_wall:[[370,800,774,998],[572,988],.24],
  kitchen:[[791,724,1160,1008],[976,997],.15],
  supply:[[1191,699,1518,1007],[1355,996],.15],
};

function publish(path,bytes){
  const value=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  if(!existsSync(path)||!readFileSync(path).equals(value))writeFileSync(path,value);
}
function sheetDefinitions(name,specs,directory){
  const image=`ink_${name}.png`,frames={},definitions={};
  for(const[id,[rect,contact,scale]]of Object.entries(specs)){
    const[x,y,right,bottom]=rect,anchor={x:contact[0]-x,y:contact[1]-y},frame={x,y,w:right-x,h:bottom-y,duration:1000};
    frames[id]={frame,anchor};
    definitions[id]={image:`/pixel-world/${image}`,width:frame.w,height:frame.h,sheet_width:1536,sheet_height:1024,render_style:'ink',anchor_mode:'source',anchor,native_scale:scale,animations:{idle:{loop:false,frames:[frame]}}};
  }
  publish(resolve(directory,`ink_${name}.atlas.json`),JSON.stringify({frames,meta:{image,size:{w:1536,h:1024},source:'original-imagegen-transparent-atlas',render_style:'ink'}},null,2)+'\n');
  return definitions;
}

export function applyInkWorldAssets(manifest,root){
  const directory=resolve(root,'public/pixel-world');
  for(const name of['environment','buildings','ground'])publish(resolve(directory,`ink_${name}.png`),readFileSync(resolve(root,`art/ink-world/${name}.png`)));
  const environment=sheetDefinitions('environment',environmentFrames,directory),buildings=sheetDefinitions('buildings',buildingFrames,directory);
  Object.assign(manifest.wilderness||=( {}),environment,{tree_mature:environment.pine,tree_stump:environment.stump});
  Object.assign(manifest.props,{
    bookshop:buildings.bookshop,cottage:buildings.cottage,shed:buildings.shed,well:buildings.well,
    // Seating and column are replaced below by the isolated supplement frames.
    bench:buildings.game_table,game_table:buildings.game_table,portal_plaza:buildings.portal,portal_adventure:buildings.portal,
    ruin_arch:buildings.ruin_arch,ruin_column:buildings.ruin_column,ruin_wall:buildings.ruin_wall,
    pine:environment.pine,pine_tall:environment.pine,oak:environment.oak,birch:environment.oak,apple:environment.oak,
    dead_tree:environment.dead_tree,rock:environment.stones,rock_large:environment.ore,
  });
  Object.assign(manifest.landmarks,{wood:environment.branches,ore:environment.stones,kitchen:buildings.kitchen,supply:buildings.supply});
  const ground={image:'/pixel-world/ink_ground.png',width:1536,height:1024,render_style:'ink',terrain_overlay:true};
  publish(resolve(directory,'ink_ground.atlas.json'),JSON.stringify({frames:{world:{frame:{x:0,y:0,w:1536,h:1024},anchor:{x:0,y:0}}},meta:{image:'ink_ground.png',size:{w:1536,h:1024},source:'original-imagegen-walkable-ground',render_style:'ink'}},null,2)+'\n');
  Object.assign(manifest,{release:'0.25.0',render_style:'ink',map:{width:48,height:32},scene:{...ground},scenes:{plaza:{...ground},adventure:{...ground}}});
  applyInkFarmEffects(manifest,root);
  applyInkActors(manifest,root);
  applyInkInventory(manifest,root);
  applyFeiyuPaperDoll(manifest,root);
  return manifest;
}

import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {applyInkWorldAssets} from '../art/ink-world/manifest.mjs';

// Re-publish measured ink metadata and untouched source PNGs without requiring
// the optional Pixelbolt authoring tool or rebuilding the legacy pixel recipes.
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(readFileSync(resolve(root,'public/pixel-world/manifest.json'),'utf8'));
const output=JSON.stringify(applyInkWorldAssets(manifest,root),null,2)+'\n';
for(const path of ['public/pixel-world/manifest.json','art/pixel-world/recipes/manifest.json'])writeFileSync(resolve(root,path),output);
console.log(`Published ink world ${manifest.release}, ${Object.keys(manifest.paper_dolls).length} paper-doll rig.`);

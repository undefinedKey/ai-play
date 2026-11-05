import { readFileSync,writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createPlazaMap } from '../shared/plaza-map.js';
const path=new URL('../shared/maps/plaza.json',import.meta.url),text=JSON.stringify(createPlazaMap(),null,2)+'\n';
if(process.argv.includes('--check')) assert.equal(readFileSync(path,'utf8'),text,'plaza.json must be regenerated from plaza-layout.mjs');
else writeFileSync(path,text);
console.log(process.argv.includes('--check')?'plaza map matches portable contract':'plaza map generated from portable contract');

// Phaser 4.2.1 compares an interpolated texture index with exact floats. Some
// WebGL drivers interpolate e.g. 3 as 2.9999998 inside a rotated quad, selecting
// the transparent fallback. Round the index (never the UVs) before branching.
// This shader addition keeps batching many textures in one draw call.
const cache=new Map();
export function stableTextureSampler(count){
  if(cache.has(count))return cache.get(count);
  if(!Number.isInteger(count)||count<1)throw new RangeError('Texture count must be a positive integer');
  const branches=Array.from({length:count},(_,i)=>`${i?'else ':''}if (textureId == ${i}.0) return texture2D(uMainSampler[${i}], texCoord);`).join('\n');
  const addition={name:`WorldStableTexture${count}`,tags:['TEXTURE'],additions:{
    fragmentHeader:`uniform sampler2D uMainSampler[TEXTURE_COUNT];\nvec4 getTexture (vec2 texCoord) {\n${count===1?'return texture2D(uMainSampler[0], texCoord);':`float textureId = floor(outTexDatum + 0.5);\n${branches}\nreturn vec4(0.0);`}\n}`,
    fragmentProcess:'vec4 fragColor = getTexture(texCoord);'
  }};
  cache.set(count,addition);return addition;
}

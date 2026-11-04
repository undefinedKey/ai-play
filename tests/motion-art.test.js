// Historical ink renderer coverage; active Q art is covered by v034 tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('../art/ink-world/v033-manifest.json',import.meta.url)));
const geometry=JSON.parse(readFileSync(new URL('../art/ink-world/actor-geometry.json',import.meta.url)));
const key=(frame,definition)=>[frame.image||definition.image,frame.x,frame.y,frame.w,frame.h].join(':');

test('all eight identities use distinct contact/passing and running phases in every authored direction',()=>{
  for(const[id,body]of Object.entries(manifest.characters))for(const direction of ['south','north','east']){
    for(const action of ['walk','run']){
      const frames=body.animations[`${action}_${direction}`].frames;
      assert.equal(new Set(frames.map(frame=>key(frame,body))).size,4,`${id}/${direction}/${action} repeats the same contact pose`);
      assert.ok(frames.every(f=>f.duration>0));
    }
    assert.deepEqual(body.motion_images,[`/pixel-world/ink_motion_${id}.png`]);
  }
});

test('damage and axe/pickaxe recovery no longer reuse the kneeling gathering drawing',()=>{
  for(const[id,body]of Object.entries(manifest.characters))for(const[index,direction]of ['south','north','east'].entries()){
    const crouch=geometry[id].rows[6][index],crouchKey=key(crouch,body);
    const recoil=body.animations[`hurt_${direction}`].frames;
    assert.equal(recoil[0].image,body.motion_images[0]);
    for(const action of ['hurt','gather','attack']){
      assert.ok(body.animations[`${action}_${direction}`].frames.every(f=>key(f,body)!==crouchKey),`${id}/${action} abruptly kneels`);
    }
  }
});

test('equipment, accessories and tools retain the exact body phase durations after supplementary art',()=>{
  const body=manifest.characters.wanderer_1;
  for(const group of ['equipment','accessories','tools'])for(const[id,definition]of Object.entries(manifest[group])){
    for(const action of ['walk','run','attack','hurt','gather'])for(const direction of ['south','north','east']){
      const name=`${action}_${direction}`;
      assert.deepEqual(definition.animations[name].frames.map(f=>f.duration),body.animations[name].frames.map(f=>f.duration),`${group}/${id}/${name} drifts from body`);
    }
  }
});

test('monster directional cadence stays coherent while light and heavy creatures have distinct weight',()=>{
  const cadence=(id,action,direction='south')=>manifest.monsters[id].animations[`${action}_${direction}`].frames.map(f=>f.duration);
  for(const id of Object.keys(manifest.monsters))for(const action of ['walk','run','attack','hurt']){
    for(const direction of ['north','east'])assert.deepEqual(cadence(id,action,direction),cadence(id,action));
  }
  assert.notDeepEqual(cadence('forest_slime','walk'),cadence('ruins_guardian','walk'));
  assert.notDeepEqual(cadence('forest_boar','attack'),cadence('ruins_guardian','attack'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentConfig } from '../server/config.js';
test('spectator capacity and buffering are explicit trusted bounded configuration',()=>{
  assert.deepEqual(deploymentConfig().spectator,{maxStreams:150,maxPerIp:30,maxBufferBytes:262144});
  assert.deepEqual(deploymentConfig({spectatorOptions:{maxStreams:120,maxPerIp:100,maxBufferBytes:65536}}).spectator,{maxStreams:120,maxPerIp:100,maxBufferBytes:65536});
  for(const [key,values] of [['maxStreams',[0,2001,2.5,'oops']],['maxPerIp',[-1,2001]],['maxBufferBytes',[1,1048577]]])for(const value of values)assert.throws(()=>deploymentConfig({spectatorOptions:{[key]:value}}));
});

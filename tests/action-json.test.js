import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ACTION_REPLY_LENGTH, parseActionJson } from '../skills/ai-plaza/scripts/action-json.mjs';
import { parseModelAction } from '../skills/ai-plaza/scripts/runtime.mjs';
import { expandDecisionReferences } from '../skills/ai-plaza/scripts/dsh-pet.mjs';

const food = { type: 'inventory', payload: { intent: 'use', item_id: 'turnip' } };
const serialized = JSON.stringify(food);

test('线上原桌宠的无引号对象键保留原动作并展开本次食物ID', () => {
  const response = '还是饿，再啃一口试试。\n\n{type:"inventory",payload:{intent:"use",item_id:"F"}}';
  assert.deepEqual(parseModelAction(expandDecisionReferences(response, { F: 'turnip' })), food);
  assert.deepEqual(parseModelAction('{type:"adventure_plan",payload:{intent:"explore",zone_id:"forest",mode:"run"}}'), {
    type: 'adventure_plan', payload: { intent: 'explore', zone_id: 'forest', mode: 'run' },
  });
  assert.deepEqual(parseModelAction('{type:"move",payload:{"x":12,y:9}}'), { type: 'move', payload: { x: 12, y: 9 } });
});

test('无引号键兼容只读取数据，不执行表达式或猜测有歧义的动作', () => {
  for (const content of [
    '{type:inventory,payload:{intent:"use",item_id:"turnip"}}',
    '{type:"inventory",payload:{intent:"use",item_id:process.env.SECRET}}',
    '{type:"inventory",payload:{intent:"use",item_id:(()=>"turnip")()}}',
    '{type:"move",payload:{x:1+2,y:3}}',
    '{type:"move",payload:{x:NaN,y:Infinity}}',
    '{type:"move",payload:{x:0x10,y:2}}',
    '{type:"wait",payload:{},type:"inventory"}',
    '{type:"wait",payload:{},"type":"inventory"}',
    '{type:"wait",payload:{},__proto__:{polluted:true}}',
    '{type:"wait",payload:{},constructor:{prototype:{polluted:true}}}',
    '{type:"wait",payload:{},}',
    '{type:"wait",payload:{/* instruction */}}',
    '{type:"wait",payload:{}}\n{type:"wait",payload:{}}',
    '{wrapper:{type:"wait",payload:{}}}',
    '{type:"inventory",payload:{intent:"use",item_id:"F"}} broken {oops}',
    '{type:"gather",payload:{target:"wood"}}',
  ]) assert.throws(() => parseModelAction(content), { code: 'INVALID_MODEL_OUTPUT' }, content);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseModelAction('{type:"wait",payload:' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}'), { code: 'INVALID_MODEL_OUTPUT' });
});

test('原桌宠碎碎念后的单个动作和代码块按原动作解析，不公开前置文字', () => {
  for (const content of [serialized, `肚子都瘪了，再试一口萝卜。\n\n${serialized}`,
    `\n\`\`\`json\n${serialized}\n\`\`\`\n`, `先吃一点。\n\`\`\`JSON\n${serialized}\n\`\`\`\n然后再看看。`]) {
    assert.deepEqual(parseModelAction(content), food);
  }
  const approach = { type: 'survival', payload: { intent: 'approach', site_id: 'plaza_hearth', mode: 'run' } };
  assert.deepEqual(parseModelAction(`先爬到火堆旁边，暖和点再说。\n\n${JSON.stringify(approach)}`), approach);
});

test('字符串中的括号、引号和反斜线不会变成动作边界', () => {
  const action = { type: 'say', payload: { channel: 'nearby', text: '符号 {} [] "引号" \\ 和 {"type":"wait","payload":{}} 都只是聊天' } };
  assert.deepEqual(parseModelAction(`我准备说一句。\n${JSON.stringify(action)}`), action);
});

test('多动作、破损JSON、嵌套包装、纯自然语言及过大输入仍被拒绝', () => {
  for (const content of [
    '我已经吃了萝卜', `${serialized}\n${serialized}`, `先选 ${serialized} 或 ${serialized}`,
    `\`\`\`json\n${serialized}\n\`\`\`\n\`\`\`json\n${serialized}\n\`\`\``,
    `坏数据 {broken} 然后 ${serialized}`, `${serialized} 接着 {broken}`,
    `我先试 {"type":"inventory","payload":${serialized}`, `我先试 [${serialized}]`,
    `我先试 {"action":${serialized}}`, '先试 {"type":"wait","payload":{]}',
    `先试 {"type":"wait","payload":{} 然后 ${serialized}`, `${serialized} }`,
    '前置'.repeat(MAX_ACTION_REPLY_LENGTH) + serialized, JSON.stringify(serialized),
  ]) assert.throws(() => parseModelAction(content), { code: 'INVALID_MODEL_OUTPUT' });
  assert.throws(() => parseActionJson({ toString: () => serialized }), SyntaxError);
});

test('提取后的动作仍通过原有字段/类型/动作许可校验，不修复动作', () => {
  for (const action of [
    { type: 'shell', payload: { command: 'something' } },
    { type: 'move', payload: { x: 1.5, y: 2 } },
    { type: 'inventory', payload: { intent: 'use', item_id: 'turnip', command: 'something' } },
    { type: 'inventory', payload: { intent: 'use' } }, { type: 'wait', payload: [] },
  ]) assert.throws(() => parseModelAction(`我已经决定了。\n${JSON.stringify(action)}`), { code: 'INVALID_MODEL_OUTPUT' });
});

test('前置碎碎念和代码块中的短ID在校验前使用本次映射，文本不展开', () => {
  const action = { type: 'survival', payload: { intent: 'approach', site_id: '@V1', mode: 'run' } };
  const response = `先过去。\n\`\`\`json\n${JSON.stringify(action)}\n\`\`\``;
  assert.deepEqual(parseModelAction(expandDecisionReferences(response, { '@V1': 'plaza_hearth' })), {
    type: 'survival', payload: { intent: 'approach', site_id: 'plaza_hearth', mode: 'run' },
  });
  assert.throws(() => expandDecisionReferences(response, {}), { code: 'INVALID_MODEL_OUTPUT' });
  const chat = { type: 'say', payload: { channel: 'group', group_id: 'H', text: '@V1 和 H 是我的原话' } };
  assert.deepEqual(parseModelAction(expandDecisionReferences(`想说话。\n${JSON.stringify(chat)}`, { H: 'group_real', '@V1': 'other' })), {
    ...chat, payload: { ...chat.payload, group_id: 'group_real' },
  });
  const ambiguous = `${response}\n${serialized}`;
  assert.equal(expandDecisionReferences(ambiguous, { '@V1': 'plaza_hearth' }), ambiguous);
  assert.throws(() => parseModelAction(expandDecisionReferences(ambiguous, { '@V1': 'plaza_hearth' })), { code: 'INVALID_MODEL_OUTPUT' });
});

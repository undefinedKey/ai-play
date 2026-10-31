import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { GAME_TIMING } from '../server/games.js';
import { WORLD_MAP } from '../shared/world-layout.js';

function fixture(t) {
  let now = 1000000;
  const world = new World({ now: () => now, actionIntervalMs: 0 }); t.after(() => world.close());
  const people = ['甲', '乙'].map(name => {
    const a = world.createAgent({ name }), c = world.createController(a.agent_id), auth = world.authenticate(c.token);
    world.ownerControl(a.agent_id, 'start', { controller_id: c.controller_id, duration_minutes: 60 });
    world.callTool(auth, 'join_world'); return { id: a.agent_id, auth };
  });
  const session = p => ({ run_id: world.agent(p.id).run.run_id, session_epoch: world.agent(p.id).session_epoch });
  const observe = p => world.callTool(p.auth, 'observe', session(p));
  const act = (p, type, payload = {}) => world.callTool(p.auth, 'act', { ...session(p), action_id: observe(p).next_action_id, type, payload });
  const advance = ms => { while (ms > 0) { for (const p of people) if (world.agent(p.id).status === 'active') observe(p); const step = Math.min(ms, 30000); now += step; ms -= step; world.tick(); } };
  return { world, people, observe, act, advance, session, now: () => now };
}

test('150-second invitation does not stack after old cooldown, preserves its deadline and expires at the exact boundary', t => {
  const f = fixture(t), [a, b] = f.people, group_id = f.act(a, 'create_group').group_id;
  const invite = f.act(a, 'invite', { group_id, target_agent_id: b.id });
  assert.equal(invite.expires_at - f.now(), GAME_TIMING.invitation_seconds * 1000);
  f.advance(61000);
  assert.equal(f.act(a, 'invite', { group_id, target_agent_id: b.id }).error.code, 'INVITE_PENDING');
  f.act(b, 'wait'); f.world.callTool(b.auth, 'join_world');
  assert.equal(f.observe(b).invitations[0].expires_at, invite.expires_at);
  f.advance(88999); assert.equal(f.observe(b).invitations.length, 1);
  f.advance(1); assert.equal(f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true }).error.code, 'INVITE_EXPIRED');
  assert.equal(f.world.agent(b.id).group_id, null);
  const next = f.act(a, 'invite', { group_id, target_agent_id: b.id }); assert.equal(next.status, 'applied');
  f.act(b, 'respond_invite', { invite_id: next.invite_id, accept: false });
  assert.equal(f.act(a, 'invite', { group_id, target_agent_id: b.id }).error.code, 'INVITE_COOLDOWN');
});

for (const type of ['word_chain', 'story_chain', 'rock_paper_scissors']) test(`${type}: fixed per-game deadlines, slow valid response, late old turn rejected without extending authorization`, t => {
  const f = fixture(t), [a, b] = f.people, group_id = f.act(a, 'create_group').group_id;
  const invite = f.act(a, 'invite', { group_id, target_agent_id: b.id }); f.act(b, 'respond_invite', { invite_id: invite.invite_id, accept: true });
  const grants = f.people.map(p => structuredClone(f.world.agent(p.id).run));
  const { game_id } = f.act(a, 'propose_game', { group_id, game_type: type }); const recruitment = f.world.state.game.deadline;
  f.advance(60000); f.act(b, 'respond_game', { game_id, accept: true });
  assert.equal(f.world.state.game.deadline, recruitment); f.advance(90000);
  let game = f.world.state.game; const deadline = game.deadline, turn_id = game.turn_id;
  assert.deepEqual(game.timing, GAME_TIMING); assert.equal(deadline - f.now(), 150000);
  f.advance(60000); f.act(a, 'wait'); assert.equal(game.deadline, deadline);
  const action = type === 'word_chain' ? ['submit_word', { game_id, turn_id, word: '气球' }] : type === 'story_chain' ? ['submit_story', { game_id, turn_id, text: '慢慢想好的一段故事。' }] : ['submit_move', { game_id, turn_id, choice: 'rock' }];
  assert.equal(f.act(a, ...action).status, 'applied');
  if (type === 'rock_paper_scissors') {
    assert.equal(f.world.state.game.deadline, deadline, 'first hidden choice does not extend the round');
    f.advance(60000); assert.equal(f.act(b, 'submit_move', { game_id, turn_id, choice: 'paper' }).status, 'applied');
  }
  game = f.world.state.game; assert.equal(game.deadline - f.now(), 150000);
  assert.equal(f.act(a, ...action).error.code, 'STALE_TURN');
  f.advance(150000);
  assert.equal(f.act(a, ...action).error.code, 'STALE_TURN');
  f.people.forEach((p, i) => assert.deepEqual(f.world.agent(p.id).run, grants[i]));
});

test('solo catalog uses finite response windows; every treasure target is a distinct on-map cell within six Manhattan tiles', t => {
  const f = fixture(t), a = f.world.agent(f.people[0].id), rules = f.world.getRules();
  for (const id of ['solo_game', 'riddle', 'sequence']) assert.equal(rules.activities.find(x => x.id === id).duration_seconds, 150);
  for (const [id, seconds] of [['watch_pond', 45], ['read', 45], ['relax', 60], ['treasure_hunt', 900]]) assert.equal(rules.activities.find(x => x.id === id).duration_seconds, seconds);
  for (const position of [{ x: 0, y: 0 }, { x: WORLD_MAP.width - 1, y: WORLD_MAP.height - 1 }, { x: 11, y: 8 }]) {
    a.position = position; a.activity = {};
    for (let i = 0; i < 500; i++) { f.world.nextTreasure(a); const p = a.activity.target, distance = Math.abs(p.x - position.x) + Math.abs(p.y - position.y); assert.ok(distance >= 1 && distance <= 6); assert.ok(p.x >= 0 && p.x < WORLD_MAP.width && p.y >= 0 && p.y < WORLD_MAP.height); }
  }
  a.activity = null;
});

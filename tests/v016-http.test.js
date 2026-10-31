import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/index.js';
import { findPath } from '../server/spatial.js';
import { initializeEconomy } from '../server/economy.js';

// All decisions are scripted test assertions. HTTP/MCP is real; no production
// actor, model, credential or database participates in these tests.
async function fixture(t, accounts = false) {
  const app = await createApp({ dbPath: ':memory:', authDbPath: ':memory:', frontend: false, demo: false,
    ...(accounts ? { authMode: 'accounts', publicUrl: 'http://cooperation.example:3000', allowHttp: true } : {}) });
  const password = 'Cooperation-fixture-only-2026!';
  if (accounts) await app.accounts.createAdmin({ username: 'coop_admin', password, name: 'fixture admin' });
  let now = Date.now(); app.world.now = () => now; app.world.actionIntervalMs = 0;
  const { server, url } = await app.start(0), actors = [];
  t.after(async () => { await Promise.all(actors.map(p => p.client.close())); await app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const api = async (path, data, auth = {}) => {
    const response = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', ...(accounts ? { Origin: app.config.publicUrl.origin } : {}),
      ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.csrf_token ? { 'X-CSRF-Token': auth.csrf_token } : {}),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json();
    return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf_token: body.csrf_token };
  };
  const actor = async (name, owner) => {
    const a = app.world.createAgent({ name, owner_id: owner?.id || name }), controller = app.world.createController(a.agent_id);
    app.world.ownerControl(a.agent_id, 'start', { controller_id: controller.controller_id, duration_minutes: 30, max_calls: 100, goal: 'PRIVATE_' + name });
    const client = new Client({ name: 'cooperation-http-test', version: '0.16.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${controller.token}` } } }));
    const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); return result.structuredContent || JSON.parse(result.content[0].text); };
    const joined = await call('join_world'), session = { run_id: joined.run_id, session_epoch: joined.session_epoch };
    const observe = () => call('observe', session);
    const request = async (type, payload) => ({ ...session, type, payload, action_id: (await observe()).next_action_id });
    const act = async (type, payload) => call('act', await request(type, payload));
    const applied = async (type, payload) => { const result = await act(type, payload); assert.equal(result.status, 'applied', JSON.stringify(result)); return result; };
    const p = { id: a.agent_id, get raw() { return app.world.agent(a.agent_id); }, client, call, observe, request, act, applied, session, token: controller.token };
    p.raw.position = { x: 11, y: 8 }; actors.push(p); return p;
  };
  const advance = async ms => { const end = now + ms; while (now < end) { now = Math.min(now + 1000, end); app.world.tick(); for (const p of actors) if (p.raw.status === 'active') await p.observe(); } };
  const publicWorld = async () => (await api('/api/public/world')).body;
  const propose = async (from, to, template_id, role_id) => {
    await from.applied('cooperation', { intent: 'propose', template_id, role_id, target_agent_id: to.id, duration_seconds: 900 });
    const invite = (await to.observe()).cooperation_invitations[0]; assert.ok(invite);
    return invite;
  };
  const accept = async (to, invite) => to.applied('cooperation', { intent: 'respond', cooperation_id: invite.cooperation_id, revision: invite.revision, accept: true, role_id: invite.role_id });
  return { app, url, api, actor, advance, publicWorld, propose, accept, password, time: () => now };
}

for (const kind of ['word_chain','story_chain','rock_paper_scissors']) test(`v0.16 HTTP/MCP: ${kind} completes with 40–60 second decisions and durable factual result`, async t=>{
  const f=await fixture(t), a=await f.actor('慢回复甲'), b=await f.actor('慢回复乙');
  const rules=await a.call('get_rules'); assert.equal(rules.game.turn_seconds,150);
  const health=(await f.api('/api/health')).body;
  assert.equal(health.version,'0.20.0'); assert.equal(health.capabilities.public_history,true);
  const group=(await a.applied('create_group',{})).group_id;
  const invite=await a.applied('invite',{group_id:group,target_agent_id:b.id});
  await f.advance(60000); await b.applied('respond_invite',{invite_id:invite.invite_id,accept:true});
  const game_id=(await a.applied('propose_game',{group_id:group,game_type:kind})).game_id;
  const deadline=(await a.observe()).game.deadline;
  await f.advance(60000); await b.applied('respond_game',{game_id,accept:true});
  assert.equal((await b.observe()).game.deadline,deadline);
  await f.advance(90000);
  const words=['气球','球场','场地','地球','球迷','迷人','人民','民族','族群','群山'];
  const grants=[a,b].map(p=>structuredClone(p.raw.run)); let oldTurn;
  for(let n=0;n<10;n++) {
    const g=(await a.observe()).game; if(g.status==='finished') break;
    if(kind==='rock_paper_scissors') {
      await f.advance(40000); await a.applied('submit_move',{game_id,turn_id:g.turn_id,choice:'rock'});
      const hidden=JSON.stringify(await f.publicWorld()); assert.ok(!hidden.includes('private_choices'));
      await f.advance(60000); await b.applied('submit_move',{game_id,turn_id:g.turn_id,choice:'scissors'});
    } else {
      const p=g.current_agent_id===a.id?a:b;
      await f.advance(n%2?60000:40000);
      const type=kind==='word_chain'?'submit_word':'submit_story';
      const payload={game_id,turn_id:g.turn_id,...(kind==='word_chain'?{word:words[n]}:{text:`真实续写第 ${n+1} 段。`})};
      const request=await p.request(type,payload), result=await p.call('act',request);
      assert.equal(result.status,'applied',JSON.stringify(result));
      assert.deepEqual(await p.call('act',request),result);
      oldTurn??={p,type,payload};
    }
  }
  const game=(await a.observe()).game; assert.equal(game.status,'finished');
  assert.deepEqual([a,b].map(p=>p.raw.run.expires_at),grants.map(g=>g.expires_at));
  if(oldTurn) assert.equal((await oldTurn.p.act(oldTurn.type,oldTurn.payload)).error.code,'STALE_TURN');
  const history=(await f.api('/api/public/history?category=game')).body;
  assert.equal(history.items.length,1); const entry=history.items[0];
  assert.equal(entry.outcome,'completed'); assert.equal(entry.details.game.game_id,game_id);
  assert.deepEqual(new Set(entry.actors.map(x=>x.agent_id)),new Set([a.id,b.id]));
  if(kind==='word_chain') assert.equal(entry.details.game.words.length,11);
  if(kind==='story_chain') assert.equal(entry.details.game.segments.length,6);
  if(kind==='rock_paper_scissors') assert.equal(entry.details.game.rounds.length,3);
  assert.ok(!JSON.stringify(history).includes('PRIVATE_'));
});

test('v0.16 HTTP/MCP: slow solo answers and three explicit nearby treasure collections fit finite windows',async t=>{
  const f=await fixture(t), p=await f.actor('独自游玩');
  for(const kind of ['solo_game','riddle','sequence']) {
    const catalog=f.app.world.getRules().activities.find(x=>x.id===kind);
    const place=f.app.world.getRules().places.find(x=>x.id===catalog.place_id);
    p.raw.position={x:place.x,y:place.y};
    await p.applied('start_activity',{activity_id:kind});
    // This tests timing, transport and settlement; the answer is a controlled fixture.
    const answer=Array.isArray(p.raw.activity_answer)?p.raw.activity_answer[0]:p.raw.activity_answer;
    const end=p.raw.activity.ends_at; await f.advance(60000);
    assert.equal(p.raw.activity.ends_at,end); await p.applied('finish_activity',{answer});
  }
  p.raw.position={x:11,y:8}; await p.applied('start_activity',{activity_id:'treasure_hunt'});
  const deadline=p.raw.activity.ends_at;
  for(let n=0;n<3;n++) {
    let a=(await p.observe()).self, target=a.activity.target;
    assert.ok(Math.abs(a.position.x-target.x)+Math.abs(a.position.y-target.y)<=6);
    while(a.position.x!==target.x||a.position.y!==target.y) {
      const path=findPath('plaza',a.position,target);assert.ok(path, 'treasure target is reachable');
      const next=path[Math.min(3,path.length-1)];
      await f.advance(40000); await p.applied('move',next);a=(await p.observe()).self;
    }
    await f.advance(40000); assert.equal(p.raw.activity.ends_at,deadline);await p.applied('finish_activity',{});
  }
  assert.equal(p.raw.activity,null);
  const history=(await f.api('/api/public/history?category=activity')).body.items;
  assert.equal(history.length,4);assert.ok(history.every(e=>e.outcome==='completed'));
});

test('v0.16 accounts HTTP: public history is identical for anonymous, actor owner, other owner and admin; filtering is strict',async t=>{
  const f=await fixture(t,true), admin=await f.api('/api/auth/login',{username:'coop_admin',password:f.password});
  const owner=async username=>{
    const invitation=await f.api('/api/admin/invites',{expires_hours:1},admin);
    return f.api('/api/auth/register',{username,password:f.password,name:username,invite_code:invitation.body.invite_code});
  };
  const own=await owner('history_owner'), other=await owner('history_other');
  const a=await f.actor('有公开经历',own.body.owner), b=await f.actor('私密邀请目标',other.body.owner);
  await a.applied('say',{channel:'nearby',text:'这句话可公开查看。'});
  await f.propose(a,b,'camp_meal','supplier');
  const first=(await f.api('/api/public/history')).body;
  for(const auth of [{},own,other,admin]) {
    const response=await f.api('/api/public/history',undefined,auth);assert.equal(response.status,200);
    assert.deepEqual(response.body.items,first.items);
    const text=JSON.stringify(response.body);
    for(const secret of ['PRIVATE_',a.token,b.token,'target_agent_id','inventory','controller_id','owner_id'])assert.ok(!text.includes(secret),secret);
    assert.ok(response.body.items.every(e=>e.category!=='cooperation'));
  }
  for(const suffix of ['?limit=0','?limit=51','?limit=1.5','?category=private','?agent_id=unknown','?from=9&to=1','?before=bad','?limit=2&limit=3','?password=secret'])
    assert.equal((await f.api('/api/public/history'+suffix)).status,400,suffix);
  const filtered=(await f.api(`/api/public/history?agent_id=${a.id}&category=speech&from=${f.time()}&to=${f.time()}`)).body;
  assert.equal(filtered.items.length,1);assert.equal(filtered.items[0].details.text,'这句话可公开查看。');
  const world=await f.publicWorld();assert.ok(world.history.archive_id);assert.ok(!('entries' in world.history));
  assert.ok(!('history' in await a.observe()),'full archive is not injected into model observation');
});

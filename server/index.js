import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { World } from './world.js';
import { attachMcp } from './mcp.js';
import { AccountStore } from './auth.js';
import { deploymentConfig, authDatabasePath, isLoopback } from './config.js';
import { SkillPairingStore, approvalOptions } from './skill-pairing.js';
import { attachSpectator } from './spectator.js';

const ROOT = resolve(import.meta.dirname, '..');
const fail = (code, message) => Object.assign(new Error(message), { code });
const sameSecret = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createApp({ dbPath = resolve(ROOT, 'data/world.sqlite'), demo = true, seed = true, frontend = true, production = false, authDbPath, pairingNow = Date.now, ...deployment } = {}) {
  const config = deploymentConfig(deployment);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const world = new World({ dbPath });
  world.setMaxListeners(100);
  const app = express();
  const ownerSession = randomBytes(32).toString('hex');
  const accounts = config.mode === 'accounts' ? new AccountStore({ dbPath: authDatabasePath(dbPath, authDbPath) }) : null;
  const localOwner = { id: 'local-owner', username: 'local-owner', name: '本地主人', role: 'admin' };
  const credentialsPath = dbPath === ':memory:' ? null : resolve(dirname(dbPath), 'demo-credentials.json');
  let demoCredentials = credentialsPath && existsSync(credentialsPath) ? JSON.parse(readFileSync(credentialsPath, 'utf8')) : [];
  const runners = new Map();
  const streams = new Map();
  const skillPairing = new SkillPairingStore({ now: pairingNow });
  let baseUrl, stopped = false, reconciling = false;
  const cookieToken = req => /(?:^|;\s*)plaza_owner=([^;]*)/.exec(req.get('cookie') || '')?.[1] || '';
  const cookieOptions = { httpOnly: true, sameSite: 'strict', path: '/', secure: config.secureCookies };
  const sessionPayload = session => ({ owner: session?.owner || null, mode: accounts ? 'accounts' : 'local-prototype', demo_enabled: demo, ...(session?.csrf_token ? { csrf_token: session.csrf_token } : {}) });
  const snapshotFor = owner => {
    const snapshot = accounts ? world.snapshotFor(owner) : { ...world.ownerSnapshot(), viewer: localOwner };
    if (!demo) snapshot.controllers = snapshot.controllers.filter(c => c.kind !== 'demo');
    return snapshot;
  };
  const authenticated = token => accounts ? accounts.session(token) : sameSecret(token, ownerSession) ? { owner: localOwner } : null;
  const persistCredentials = () => { if (credentialsPath) writeFileSync(credentialsPath, JSON.stringify(demoCredentials, null, 2), { mode: 0o600 }); };
  function addDemoController(agent) {
    const controller = world.createController(agent.agent_id, { name: '本地模拟运行器', kind: 'demo' });
    demoCredentials.push({ agent_id: agent.agent_id, ...controller });
    persistCredentials();
    return { controller_id: controller.controller_id, name: '本地模拟运行器', kind: 'demo' };
  }
  if (seed && world.ownerSnapshot().agents.length === 0) {
    for (const profile of [
      { name: '小禾', bio: '喜欢散步和认识新朋友。欢迎来到共栖！', avatar: '🌱', color: '#477755' },
      { name: '阿橘', bio: '接龙爱好者，总能找到话题的下一站。', avatar: '🍊', color: '#cf773d' },
    ]) addDemoController(world.createAgent({ ...profile, is_platform: true }));
  }
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.get('host') || '';
    const internal = isLoopback(req.socket.remoteAddress) && baseUrl && host === new URL(baseUrl).host;
    const allowedHost = accounts ? host === config.publicUrl.host || internal : /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
    if (!allowedHost) return res.status(403).json({ error: { code: 'INVALID_HOST', message: '请通过配置的广场地址访问' } });
    const origin = req.get('origin');
    const expectedOrigin = accounts ? config.publicUrl.origin : `http://${host}`;
    if (origin && origin !== expectedOrigin) return res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: '仅允许同源访问' } });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    if (production) res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (config.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '请求须使用 JSON 对象' } });
      const deviceRequest = req.method === 'POST' && ['/skill/pair', '/skill/pair/poll'].includes(req.path) && !req.get('origin');
      if (accounts && !deviceRequest && req.get('origin') !== config.publicUrl.origin) return res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: '写操作必须从广场页面发起' } });
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.4.0', mode: accounts ? 'accounts' : 'local-prototype', capabilities: { skill_pairing: true, public_spectator: true } }));
  const spectator = attachSpectator(app, world);
  app.post('/api/skill/pair', (req, res) => {
    res.status(201).json(skillPairing.create(req.body, req.socket.remoteAddress, config.publicUrl?.origin || baseUrl));
  });
  app.post('/api/skill/pair/poll', (req, res) => res.json(skillPairing.poll(req.body)));
  app.get('/api/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!accounts) { res.cookie('plaza_owner', ownerSession, { ...cookieOptions, maxAge: 86400000 }); return res.json(sessionPayload({ owner: localOwner })); }
    res.json(sessionPayload(accounts.session(cookieToken(req))));
  });
  let authPending = 0;
  const attempts = new Map();
  for (const operation of ['login', 'register']) app.post(`/api/auth/${operation}`, async (req, res) => {
    if (!accounts) throw fail('INVALID_ACTION', '本地模式无需登录');
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const key = req.socket.remoteAddress;
    const attempt = attempts.get(key) || { count: 0, until: now + 600000 };
    if (++attempt.count > 20 || authPending >= 4 || attempts.size > 10000) { res.set('Retry-After', '60'); throw fail('RATE_LIMITED', '登录请求过多，请稍后重试'); }
    attempts.set(key, attempt); authPending++;
    try {
      const result = await accounts[operation](req.body);
      res.cookie('plaza_owner', result.token, { ...cookieOptions, maxAge: Math.max(0, result.expires_at - Date.now()) });
      res.status(operation === 'register' ? 201 : 200).json(sessionPayload(result));
    } finally { authPending--; }
  });
  app.use('/api', (req, res, next) => {
    const token = cookieToken(req);
    const session = authenticated(token);
    if (!session) return res.status(401).json({ error: { code: 'NOT_AUTHORIZED', message: accounts ? '请登录后进入邀请广场' : '请刷新页面以恢复本地主人会话' } });
    if (accounts && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameSecret(req.get('x-csrf-token') || '', session.csrf_token)) return res.status(403).json({ error: { code: 'INVALID_CSRF', message: '操作凭证已失效，请刷新页面后重试' } });
    req.owner = session.owner; req.sessionToken = token;
    next();
  });
  app.post('/api/auth/logout', (req, res) => {
    accounts?.logout(req.sessionToken);
    for (const [stream, info] of streams) if (info.token === req.sessionToken) { stream.end(); streams.delete(stream); }
    res.clearCookie('plaza_owner', cookieOptions); res.json({ ok: true });
  });
  app.post('/api/admin/invites', (req, res) => {
    if (!accounts || req.owner.role !== 'admin') throw fail('NOT_AUTHORIZED', '只有管理员可以发放邀请码');
    res.status(201).json(accounts.createInvite(req.owner.id, { expires_hours: req.body.expires_hours }));
  });
  const getAgent = (id, owner) => {
    const agent = world.ownerSnapshot().agents.find(a => a.agent_id === id && !a.is_platform && world.ownerOf(id) === owner.id);
    if (!agent) throw fail('NOT_AUTHORIZED', '只能控制自己的角色');
    return agent;
  };
  app.get('/api/skill/pair/:code', (req, res) => res.json(skillPairing.describe(req.params.code)));
  app.post('/api/skill/pair/:code/approve', (req, res) => {
    const options = approvalOptions(req.body);
    getAgent(options.agent_id, req.owner);
    const result = skillPairing.approve(req.params.code, req.owner.id, options.agent_id, clientName => {
      world.tick();
      const agent = getAgent(options.agent_id, req.owner);
      const snapshot = world.ownerSnapshot();
      if (snapshot.room.status === 'paused') throw fail('ROOM_PAUSED', '房间已暂停，请先恢复房间');
      if (agent.run?.status === 'active' && !options.transfer) throw fail('CONTROLLER_BUSY', '当前角色已有活动授权，请明确确认转交控制权');
      if (snapshot.controllers.filter(c => c.agent_id === options.agent_id).length >= 10) throw fail('LIMIT_REACHED', '每个角色最多10个控制端');
      const controller = world.createController(options.agent_id, { name: clientName, kind: 'external' });
      try {
        world.ownerControl(options.agent_id, agent.run?.status === 'active' ? 'transfer' : 'start', { ...options, controller_id: controller.controller_id });
      } catch (error) {
        // Avoid leaving an unused credential if a precondition or persistence step fails.
        delete world.state.controllers[controller.controller_id]; world.commit(); throw error;
      }
      return { token: controller.token, mcp_url: `${config.publicUrl?.origin || baseUrl}/mcp`, agent_id: options.agent_id, controller_id: controller.controller_id, agent_name: agent.name };
    });
    res.json(result);
  });
  app.post('/api/skill/pair/:code/deny', (req, res) => res.json(skillPairing.deny(req.params.code, req.owner.id)));
  app.get('/api/world', (req, res) => res.json(snapshotFor(req.owner)));
  app.get('/api/rules', (_req, res) => res.json(world.getRules()));
  app.get('/api/events', (req, res) => {
    if (streams.size >= 30) return res.status(429).json({ error: { code: 'RATE_LIMITED', message: '观众连接已达上限' } });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    streams.set(res, { owner: req.owner, token: req.sessionToken });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotFor(req.owner))}\n\n`);
    req.on('close', () => streams.delete(res));
  });
  let broadcastTimer;
  const onChange = () => {
    if (broadcastTimer || stopped) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      for (const [res, info] of streams) {
        if (res.writableLength > 256000 || !authenticated(info.token)) { res.end(); streams.delete(res); }
        else res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotFor(info.owner))}\n\n`);
      }
    }, 50);
  };
  world.on('change', onChange);
  app.post('/api/agents', (req, res) => {
    if (world.ownerSnapshot().agents.filter(a => !a.is_platform && world.ownerOf(a.agent_id) === req.owner.id).length >= 12) throw fail('LIMIT_REACHED', '每个账号最多保存12个角色');
    const { name, bio, avatar, color } = req.body;
    const agent = world.createAgent({ name, bio, avatar, color, owner_id: req.owner.id });
    res.status(201).json({ agent, controller: addDemoController(agent) });
  });
  app.post('/api/agents/:id/controllers', (req, res) => {
    getAgent(req.params.id, req.owner);
    if (req.body.kind !== 'external') throw fail('INVALID_ACTION', '这里只能创建外部控制端');
    if (world.ownerSnapshot().controllers.filter(c => c.agent_id === req.params.id).length >= 10) throw fail('LIMIT_REACHED', '每个角色最多10个控制端');
    const controller = world.createController(req.params.id, { name: req.body.name || '外部参考运行器', kind: 'external' });
    res.status(201).json({ ...controller, mcp_url: `${config.publicUrl?.origin || baseUrl || `http://${req.get('host')}`}/mcp` });
  });
  app.post('/api/agents/:id/control', (req, res) => {
    const agent = getAgent(req.params.id, req.owner);
    const { operation, ...options } = req.body;
    if (!['start','pause','resume','recall','transfer'].includes(operation)) throw fail('INVALID_ACTION', '未知控制操作');
    if (['start','resume','transfer'].includes(operation)) {
      if (options.controller_id && !world.ownerSnapshot().controllers.some(c => c.agent_id === agent.agent_id && c.controller_id === options.controller_id)) throw fail('NOT_AUTHORIZED', '该控制端不属于当前角色');
      const controller = world.ownerSnapshot().controllers.find(c => c.agent_id === agent.agent_id && c.controller_id === (options.controller_id || agent.run?.controller_id)) || world.ownerSnapshot().controllers.find(c => c.agent_id === agent.agent_id && c.kind === 'demo');
      if (!controller) throw fail('NOT_AUTHORIZED', '请选择有效控制端');
      if (controller.kind === 'demo' && !demo) throw fail('INVALID_ACTION', '服务器已关闭模拟运行器，请创建并选择外部控制端');
      options.controller_id = controller.controller_id;
      // An idle platform character gives its slot to a real user.
      const snapshot = world.ownerSnapshot();
      if (snapshot.agents.filter(a => a.status !== 'offline').length >= 5 && agent.status === 'offline') {
        const idle = snapshot.agents.find(a => a.is_platform && a.status !== 'offline' && (snapshot.game?.status === 'finished' || !snapshot.game?.participants?.includes(a.agent_id)));
        if (idle) world.ownerControl(idle.agent_id, 'recall');
      }
    }
    const state = world.ownerControl(agent.agent_id, operation, options);
    res.json({ ok: true, state });
  });
  app.post('/api/agents/:id/test', (req, res) => {
    getAgent(req.params.id, req.owner);
    const controller = world.ownerSnapshot().controllers.find(c => c.agent_id === req.params.id && c.controller_id === req.body.controller_id);
    if (!controller) throw fail('NOT_AUTHORIZED', '无效控制端');
    const auth = { agent_id: req.params.id, controller_id: controller.controller_id };
    world.callTool(auth, 'test_connection', { step: 'all' });
    res.json({ connected: true, tools: true, events: true, continuous: false, client: '本地服务隔离自检（不代表外部客户端已连接）', tested_at: new Date().toISOString() });
  });
  app.post('/api/room/control', (req, res) => {
    if (req.owner.role !== 'admin') throw fail('NOT_AUTHORIZED', '只有管理员可以控制整个房间');
    if (!['pause','resume'].includes(req.body.operation)) throw fail('INVALID_ACTION', '无效房间操作');
    res.json({ ok: true, state: world.ownerRoom(req.body.operation) });
  });
  const closeMcp = attachMcp(app, world);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
  let vite;
  if (frontend && !production) {
    const { createServer } = await import('vite');
    vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else if (frontend) {
    if (!existsSync(resolve(ROOT, 'dist/index.html'))) throw new Error('请先执行 npm run build');
    app.use(express.static(resolve(ROOT, 'dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(ROOT, 'dist/index.html')));
  }
  app.use((error, _req, res, _next) => {
    const status = error.code === 'NOT_AUTHORIZED' ? 403 : error.code === 'INVALID_CREDENTIALS' ? 401 : error.code === 'RATE_LIMITED' ? 429 : error.code ? 400 : error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: { code: error.code || 'INTERNAL_ERROR', message: error.code ? error.message : '请求失败，请重试', ...(error.details || {}) } });
  });
  async function reconcile() {
    if (!demo || !baseUrl || stopped || reconciling) return;
    reconciling = true;
    try {
      const { PlazaRunner } = await import('../runner/runner.js');
      let snapshot = world.ownerSnapshot();
      const hasUser = snapshot.agents.some(a => !a.is_platform && a.status === 'active');
      const platformLimit = Math.max(0, 5 - snapshot.agents.filter(a => !a.is_platform && a.run?.status === 'active').length);
      for (const agent of snapshot.agents.filter(a => a.is_platform)) {
        const credentials = demoCredentials.find(c => c.agent_id === agent.agent_id);
        const activePlatforms = snapshot.agents.filter(a => a.is_platform && a.run?.status === 'active').length;
        if (hasUser && snapshot.room.status !== 'paused' && agent.status === 'offline' && agent.run?.status !== 'active' && activePlatforms < platformLimit && snapshot.agents.filter(a => a.status !== 'offline').length < 5 && credentials) {
          world.ownerControl(agent.agent_id, 'start', { controller_id: credentials.controller_id, duration_minutes: 15, max_calls: 100, goal: '欢迎新朋友，邀请大家一起玩词语接龙。' });
          snapshot = world.ownerSnapshot();
        } else if ((!hasUser || activePlatforms > platformLimit) && agent.run?.status === 'active' && (!snapshot.game || snapshot.game.status === 'finished' || !snapshot.game.participants.includes(agent.agent_id))) {
          world.ownerControl(agent.agent_id, 'recall');
          snapshot = world.ownerSnapshot();
        }
      }
      snapshot = world.ownerSnapshot();
      for (const credentials of demoCredentials) {
        const agent = snapshot.agents.find(a => a.agent_id === credentials.agent_id);
        const shouldRun = agent && agent.run?.controller_id === credentials.controller_id && agent.run.status === 'active';
        if (shouldRun && !runners.has(credentials.controller_id)) {
          const checkpointPath = credentialsPath ? resolve(dirname(credentialsPath), `runner-${credentials.controller_id}.json`) : undefined;
          const runner = new PlazaRunner({ url: `${baseUrl}/mcp`, token: credentials.token, mode: 'demo', checkpointPath, pollSeconds: 10, decisionIntervalMs: 5000 });
          runners.set(credentials.controller_id, runner);
          runner.start();
          runner.ready.catch(async error => { console.error('模拟运行器启动失败:', error.message); runners.delete(credentials.controller_id); await runner.stop(); });
        }
        if (!shouldRun && runners.has(credentials.controller_id)) {
          const runner = runners.get(credentials.controller_id);
          runners.delete(credentials.controller_id);
          await runner.stop();
        }
      }
    } finally { reconciling = false; }
  }
  const timer = setInterval(() => { world.tick(); skillPairing.sweep(); void reconcile().catch(e => console.error('运行器:', e.message)); }, 500);
  const heartbeat = setInterval(() => { for (const [stream, info] of streams) { if (!authenticated(info.token)) { stream.end(); streams.delete(stream); } else stream.write(': heartbeat\n\n'); } }, 15000);
  timer.unref(); heartbeat.unref();
  return {
    app, world, accounts, config, skillPairing,
    async start(port = 3000) {
      if (accounts) {
        const admin = accounts.firstAdmin();
        if (!admin) throw new Error('请先使用 server/admin.js create-admin 初始化管理员账号，不能通过网页创建首位管理员');
        world.claimLegacyOwner(admin.id);
      }
      const server = await new Promise((resolveServer, reject) => { const instance = app.listen(port, config.host, () => resolveServer(instance)); instance.once('error', reject); });
      baseUrl = `http://${config.host === '::1' ? '[::1]' : '127.0.0.1'}:${server.address().port}`;
      return { server, url: baseUrl, publicUrl: config.publicUrl?.origin || baseUrl };
    },
    async close() {
      stopped = true; clearInterval(timer); clearInterval(heartbeat); clearTimeout(broadcastTimer);
      await Promise.allSettled([...runners.values()].map(r => r.stop()));
      closeMcp(); spectator.close(); skillPairing.close(); for (const stream of streams.keys()) stream.end();
      world.off('change', onChange); await vite?.close(); world.close(); accounts?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const application = await createApp({ production: process.argv.includes('--production'), demo: process.env.PLAZA_DEMO !== '0', dbPath: process.env.PLAZA_DB || resolve(ROOT, 'data/world.sqlite') });
  const { server, publicUrl } = await application.start(Number(process.env.PORT || 3000));
  console.log(`\n共栖 · AI 社交广场\n浏览器: ${publicUrl}\nMCP: ${publicUrl}/mcp\n模式: ${application.config.mode === 'accounts' ? '邀请测试' : '本地原型'}；模拟角色不调用模型。\n`);
  let closing = false;
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await application.close(); server.close(() => process.exit(0)); server.closeAllConnections(); });
}

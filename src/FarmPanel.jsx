import React from 'react';
import { Archive, Droplets, Leaf, LockKeyhole, Shield, Sprout, Swords, WifiOff } from 'lucide-react';

const itemName = (catalog, id) => catalog?.items?.find(item => item.id === id)?.name || id;
const remainingLabel = seconds => seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;

function CropGlyph({ crop, ready }) {
  return <svg viewBox="0 0 36 42" aria-hidden="true">{crop === 'wheat' ? <><path d="M18 38V9" stroke="#8f823f" strokeWidth="2.5" strokeLinecap="round"/>{[13,21,29].map(y => <g key={y}><ellipse cx="13" cy={y} rx="3.5" ry="7" transform={`rotate(-42 13 ${y})`} fill={ready ? '#e3b456' : '#9fb16d'}/><ellipse cx="23" cy={y-3} rx="3.5" ry="7" transform={`rotate(42 23 ${y-3})`} fill={ready ? '#efca77' : '#bcc78b'}/></g>)}</> : <><path d="M18 18C8 20 8 31 18 36c10-5 10-16 0-18Z" fill={ready ? '#eee6d0' : '#b5b986'} stroke="#8c9360" strokeWidth="1.5"/><path d="m18 35-3 5" stroke="#c9c39d" strokeWidth="2"/><path d="M18 21C5 18 5 8 9 7c8 0 9 9 9 14Z" fill="#779954"/><path d="M18 21C28 17 31 7 26 5c-7 2-9 8-8 16Z" fill="#9dbb6c"/><path d="M18 20Q12 7 18 3q7 7 0 17" fill="#88a85c"/></>}</svg>;
}

function Plot({ plot, catalog, now, live }) {
  const crop = catalog.crops?.find(item => item.id === plot.crop_id);
  const seconds = Math.max(0, Math.ceil(((plot.ready_at || 0) - now) / 1000));
  const ready = plot.ready === true;
  const planted = Boolean(plot.crop_id);
  const watered = plot.watered_at != null;
  const status = !planted ? '等待播种' : ready ? '已成熟 · 等待收获' : !watered ? '已播种 · 等待浇水' : seconds ? `生长中 · 约 ${remainingLabel(seconds)}` : '等待服务器确认成熟';
  return <article className={`farm-plot ${ready ? 'ready' : ''} ${watered ? 'watered' : ''}`} data-testid={`farm-${plot.plot_id}`}><div className="plot-label"><strong>{plot.plot_id === 'plot_1' ? '第一块田' : '第二块田'}</strong><span>{crop?.name || (planted ? plot.crop_id : '空地')}</span></div><div className={`plot-soil ${planted ? 'planted' : ''}`} aria-hidden="true">{planted ? [0,1,2,3].map(index => <CropGlyph key={index} crop={plot.crop_id} ready={ready}/>) : <Sprout size={28}/>}</div><div className="plot-state">{ready ? <Leaf size={13}/> : <Droplets size={13}/>}<span>{live ? status : `最近记录：${!planted ? '空地' : ready ? '已成熟' : watered ? '生长中' : '等待浇水'}`}</span></div>{planted && watered && !ready && <progress aria-label={`${plot.plot_id === 'plot_1' ? '第一块田' : '第二块田'}生长进度`} max={Math.max(1, plot.ready_at-plot.watered_at)} value={Math.max(0,Math.min(plot.ready_at-plot.watered_at,now-plot.watered_at))}/>}</article>;
}

export function EquipmentStatus({ agent, catalog }) {
  const life = agent?.life;
  if (!life) return null;
  return <div className="equipment-status" data-testid="equipment-status"><div className="equipment-slots"><div><Swords size={16}/><span>武器<strong>{life.equipment?.weapon ? itemName(catalog,life.equipment.weapon) : '暂未装备'}</strong></span></div><div><Shield size={16}/><span>护甲<strong>{life.equipment?.armor ? itemName(catalog,life.equipment.armor) : '暂未装备'}</strong></span></div></div><div className="equipment-stats"><span>实际攻击 <strong>{life.stats?.attack ?? '—'}</strong></span><span>实际防御 <strong>{life.stats?.defense ?? '—'}</strong></span></div></div>;
}

export default function FarmPanel({ world, selected, onSelect, now, live }) {
  const catalog = world.life;
  if (!catalog) return null;
  const agent = world.agents.find(item => item.agent_id === selected) || world.agents[0];
  return <section className="panel farm-panel" aria-labelledby="farm-panel-title"><div className="section-heading"><h2 id="farm-panel-title"><Sprout size={16}/> 营地田园</h2><span className="mini-label">每位 AI 的两块小田</span></div>{agent?.life ? <><div className="farm-owner"><span className="farm-owner-avatar" aria-hidden="true">{agent.avatar || '🌱'}</span><div><strong>{agent.name}的农田</strong><span>播种、浇水与收获，由它自己决定</span></div><select aria-label="查看谁的农田" value={agent.agent_id} onChange={event=>onSelect(event.target.value)}>{world.agents.map(item=><option value={item.agent_id} key={item.agent_id}>{item.name}</option>)}</select></div><div className="farm-plots">{agent.life.plots.map(plot=><Plot key={plot.plot_id} plot={plot} catalog={catalog} now={now} live={live}/>)}</div><div className="farm-equipment"><EquipmentStatus agent={agent} catalog={catalog}/></div><p className="farm-note">在营地照料田地，浇水后作物会慢慢长大。成熟后等待原 AI 收获，收成存入它自己的仓库。</p></> : <div className="farm-empty"><Sprout size={25}/><div><strong>田园等着第一位朋友</strong><p>真实 AI 建立角色后，会拥有自己的两块田。这里不会替它播种或创建居民。</p></div></div>}</section>;
}

export function Warehouse({ agent, catalog }) {
  const inventory = agent?.life?.inventory;
  if (!inventory || !catalog) return null;
  const equipment = agent.life.equipment || {};
  const entries = Object.entries(inventory).filter(([,quantity])=>Number.isInteger(quantity)&&quantity>0);
  return <section className="panel warehouse-panel" data-testid="private-warehouse"><div className="section-heading"><h2><Archive size={15}/> 我的 AI 仓库</h2><LockKeyhole size={13} aria-label="仅自己可见"/></div><p className="warehouse-intro">{agent.name}的物品 · 数量仅主人和它自己的接入端可见</p><div className="warehouse-items">{entries.length ? entries.map(([id,quantity])=><div key={id}><span><strong>{itemName(catalog,id)}</strong>{Object.values(equipment).includes(id)&&<small>已装备</small>}</span><b>× {quantity}</b></div>) : <p>仓库还是空的，收获作物或冒险后再来看看。</p>}</div><p className="warehouse-note">种植、制作、装备和食用由原 AI 发起。这里展示它实际拥有的物品。</p></section>;
}

const capabilityNames = { adventure:'冒险', farming:'种植', inventory:'仓库', equipment:'装备' };
const actionNames = {wait:'等待',move:'移动',say:'交流',adventure_plan:'冒险计划',farm:'照料农田',inventory:'整理物品',create_group:'创建小组',invite:'邀请同伴',respond_invite:'回应邀请'};
export function RuntimeDiagnostics({ agent }) {
  if (!agent) return null;
  const diagnostics = agent.diagnostics || {};
  const capabilities = Array.isArray(diagnostics.capabilities) ? diagnostics.capabilities : [];
  const expected = Object.keys(capabilityNames);
  const missing = expected.filter(capability=>!capabilities.includes(capability));
  const version = diagnostics.runtime_version;
  const mode = diagnostics.mode;
  const unknown = !version || !mode;
  const versionParts=version?.split('.').map(Number);
  const outdated=versionParts&&versionParts[0]===0&&versionParts[1]<9;
  const decisionLabel=actionNames[diagnostics.last_decision_type] || (diagnostics.last_decision_type ? '其他活动' : '尚未上报');
  const actionLabel=actionNames[diagnostics.last_action_type] || (diagnostics.last_action_type ? '其他活动' : '尚无记录');
  const paused = agent.status==='paused';
  const offline = agent.status!=='active'&&!paused;
  const recommendation = unknown ? '接入端版本和能力尚未核实。请更新 Skill，并重启桥或运行器，让它重新上报。' : outdated ? `上报版本 ${version} 早于本版生活玩法。请更新 Skill，并重启桥或运行器。` : missing.length ? `接入端尚未声明${missing.map(id=>capabilityNames[id]).join('、')}能力。请更新 Skill 并重启桥或运行器。` : '接入端已声明当前玩法所需能力。是否探索、种田或休息，仍由原 AI 自己选择。';
  return <section className="runtime-diagnostics" data-testid="runtime-diagnostics" aria-label="原 AI 接入状态"><h3>{offline?<WifiOff size={14}/>:<Leaf size={14}/>} 原 AI 接入状态</h3><dl><div><dt>版本</dt><dd>{version || '未上报'}</dd></div><div><dt>模式</dt><dd>{({demo:'模拟运行',model:'模型运行器','dsh-pet':'原宠物桥接'})[mode] || '未上报'}</dd></div><div><dt>上报决定</dt><dd>{decisionLabel}</dd></div><div><dt>实际动作</dt><dd>{actionLabel}{diagnostics.last_action_status==='rejected'?' · 未执行':diagnostics.last_action_status==='applied'?' · 已执行':''}</dd></div></dl>{diagnostics.last_action_status==='rejected'&&<p>服务未执行这个动作{diagnostics.last_action_error?`（${diagnostics.last_action_error}）`:''}。原 AI 需要根据回执重新决定。</p>}<p>上报决定是接入端的选择；实际动作以服务回执为准。</p><div className="runtime-capabilities">{expected.map(id=><span key={id} className={capabilities.includes(id)?'supported':''}>{capabilityNames[id]}{capabilities.includes(id)?' ✓':' · 待核实'}</span>)}</div>{offline&&<p>原 AI 当前未连接。请在它所在的机器启动并保持接入端运行；单纯安装 Skill 不会自动持续思考。</p>}{paused&&<p>角色已暂停。恢复授权后，还需要原 AI 的接入端继续运行。</p>}{mode==='demo'&&<p>当前是模拟运行，不能据此判断原 AI 的自主选择。</p>}<p className={unknown||outdated||missing.length?'runtime-update':''}>{recommendation}</p></section>;
}

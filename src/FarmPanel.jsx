import React from 'react';
import { CharacterSprite, PixelCrop, PixelItem, PixelTool, PixelFarmBackdrop } from './PixelWorld.jsx';
import SpeechOverlay from './SpeechOverlay.jsx';
import {presenceState,presenceLabel,publicName,recordTime} from './observer-state.js';
import {runtimeHealth} from './runtime-state.js';
import { Archive, Droplets, Hammer, Leaf, LockKeyhole, Shield, Sprout, Swords, WifiOff } from 'lucide-react';

const itemName = (catalog, id) => catalog?.items?.find(item => item.id === id)?.name || id;
const remainingLabel = seconds => seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;

function Plot({ plot, catalog, now, live }) {
  const crop = catalog.crops?.find(item => item.id === plot.crop_id);
  const seconds = Math.max(0, Math.ceil(((plot.ready_at || 0) - now) / 1000));
  const ready = plot.ready === true;
  const planted = Boolean(plot.crop_id);
  const watered = plot.watered_at != null;
  const tilled = plot.tilled === true || planted;
  const status = !tilled ? '未开垦 · 等待锄地' : !planted ? '已开垦 · 等待播种' : ready ? '已成熟 · 等待收获' : !watered ? '已播种 · 等待浇水' : seconds ? `生长中 · 约 ${remainingLabel(seconds)}` : '等待服务器确认成熟';
  const state = !tilled ? 'untilled' : !planted ? 'tilled' : ready ? 'ready' : watered ? 'growing' : 'seeded';
  const label = plot.plot_id === 'plot_1' ? '第一块田' : '第二块田';
  return <article className={`farm-plot farm-scene-plot ${ready ? 'ready' : ''} ${watered ? 'watered' : ''} ${tilled ? 'tilled' : 'untilled'}`} data-testid={`farm-${plot.plot_id}`} data-plot-state={state} aria-label={`${label}，${status}`}><div className="plot-label"><strong>{label}</strong><span>{crop?.name || (planted ? plot.crop_id : tilled ? '已整地' : '荒地')}</span></div><div className={`plot-soil ${planted ? 'planted' : ''}`} aria-hidden="true">{Array.from({length:8},(_,index) => <PixelCrop key={index} crop={plot.crop_id} state={state}/>)}</div><div className="plot-state" role="status">{ready ? <Leaf size={13}/> : tilled ? <Droplets size={13}/> : <Sprout size={13}/>}<span data-testid={!tilled ? 'farm-needs-tilling' : undefined}>{live ? status : `最近记录：${!tilled ? '未开垦' : !planted ? '已开垦' : ready ? '已成熟' : watered ? '生长中' : '等待浇水'}`}</span></div>{planted && watered && !ready && <progress aria-label={`${label}生长进度`} max={Math.max(1, plot.ready_at-plot.watered_at)} value={Math.max(0,Math.min(plot.ready_at-plot.watered_at,now-plot.watered_at))}/>}</article>;
}

export function EquipmentStatus({ agent, catalog }) {
  const life = agent?.life;
  if (!life) return null;
  return <div className="equipment-status" data-testid="equipment-status"><div className="equipment-slots"><div>{life.equipment?.weapon?<PixelItem id={life.equipment.weapon}/>:<Swords size={16}/>}<span>武器<strong>{life.equipment?.weapon ? itemName(catalog,life.equipment.weapon) : '暂未装备'}</strong></span></div><div>{life.equipment?.armor?<PixelItem id={life.equipment.armor}/>:<Shield size={16}/>}<span>护甲<strong>{life.equipment?.armor ? itemName(catalog,life.equipment.armor) : '暂未装备'}</strong></span></div></div><div className="equipment-stats"><span>实际攻击 <strong>{life.stats?.effective_attack ?? life.stats?.attack ?? '—'}</strong></span><span>实际防御 <strong>{life.stats?.defense ?? '—'}</strong></span></div></div>;
}

const toolNames = {hoe:'锄头',watering_can:'水壶'};
const costLabel = (catalog, cost) => Object.entries(cost || {}).filter(([,amount])=>amount>0).map(([id,amount])=>`${itemName(catalog,id)} ×${amount}`).join(' · ') || '无需材料';

function FarmTool({ id, agent, catalog, live }) {
  const tool = agent.life?.tools?.[id];
  const definition = catalog.tools?.find(item=>item.id===id);
  const name = definition?.name || toolNames[id];
  const current = definition?.levels?.find(item=>item.level===tool?.level);
  const next = definition?.levels?.find(item=>item.level===tool?.level+1);
  const max = Number(tool?.max_durability) || 0, durability = Math.max(0,Math.min(max,Number(tool?.durability)||0));
  return <article className={`farm-tool-card ${tool && durability===0?'worn':''}`} data-testid={`farm-tool-${id}`} aria-label={`${name}状态与维护目录`}>
    <div className="farm-tool-heading"><PixelTool id={id} level={tool?.level}/><div><h3>{name}</h3><span>{tool ? `Lv. ${tool.level}${!live?' · 最近记录':''}` : '农具状态待更新'}</span></div>{tool&&<span className="farm-tool-condition">{durability===0?'等待维修':'可使用'}</span>}</div>
    {tool ? <><div className="farm-tool-durability"><span>耐久</span><strong>{durability} / {max}</strong></div><progress aria-label={`${name}耐久`} value={durability} max={max||1}/>{current&&<p className="farm-tool-energy">每次{id==='hoe'?'开垦':'浇水'}消耗 {current.energy_cost} 体力</p>}<dl className="farm-tool-maintenance"><div><dt>维修材料</dt><dd>{current ? costLabel(catalog,current.repair_cost) : '等待目录更新'}</dd></div><div><dt>{next ? `升级至 Lv. ${next.level}` : current ? '当前等级' : '升级材料'}</dt><dd>{next ? costLabel(catalog,next.upgrade_cost) : current ? '已达最高等级' : '等待目录更新'}</dd></div></dl></> : <p className="farm-tool-unavailable">接入端与服务更新后，显示真实等级和耐久。</p>}
    {!!definition?.levels?.length&&<details className="farm-tool-catalog"><summary>{name}等级与维护目录</summary><ul>{definition.levels.map(level=><li key={level.level}><strong>Lv. {level.level} <span>满耐久 {level.max_durability} · 每次 {level.energy_cost} 体力</span></strong><p>{level.level===1?'初始农具':'升至此级'}：{costLabel(catalog,level.upgrade_cost)}</p><p>维修：{costLabel(catalog,level.repair_cost)}</p></li>)}</ul></details>}
  </article>;
}

export default function FarmPanel({ world, selected, onSelect, now, live }) {
  const catalog = world.life || world.rules?.life;
  if (!catalog) return <section className="farm-view" data-testid="farm-view"><p className="farm-note">农作区资料尚未载入。</p></section>;
  const agent = world.agents.find(item => item.agent_id === selected);
  const camp = catalog.farm_place || world.adventure?.zones?.find(zone=>zone.id==='camp') || {x:11,y:8,radius:2};
  const center = camp.service_center || camp;
  const inCamp = agent?.position && Math.abs(agent.position.x-center.x)+Math.abs(agent.position.y-center.y)<= (camp.radius ?? 2);
  const present = inCamp && ['active','paused'].includes(agent?.status);
  const presence = !agent ? '选择一位朋友的农田' : presenceState(agent)==='paused' ? `${publicName(agent,world.agents)}已暂停，这里展示它的田地记录。` : agent.status==='offline' ? `${publicName(agent,world.agents)}${presenceLabel(agent)}，这里展示它的田地记录。` : !inCamp ? `${agent.name}正在别处活动，这里展示它的田地记录。` : agent.status==='paused' ? `${agent.name}在营地，活动已暂停。` : `${agent.name}在营地安全区，下一步由它自己决定。`;
  return <section className="farm-view farm-panel" data-testid="farm-view" aria-labelledby="farm-panel-title">
    <div className="section-heading"><h2 id="farm-panel-title"><Sprout size={16}/> 农作区</h2><span className="mini-label">营地里的两块小田</span></div>
    {agent?.life&&<div className="farm-owner"><span className="farm-owner-avatar" aria-hidden="true"><CharacterSprite agent={agent} portrait/></span><div><strong>{agent.name}的农田</strong><span>开垦、照料与维护，由它自己决定</span></div><select aria-label="查看谁的农田" value={agent.agent_id} onChange={event=>onSelect(event.target.value)}>{world.agents.map(item=><option value={item.agent_id} key={item.agent_id}>{publicName(item,world.agents)} · {presenceLabel(item)}</option>)}</select></div>}
    <div className="map-scene-frame farm-scene-frame"><div className="farm-scene" data-testid="farm-scene"><PixelFarmBackdrop/><div className="farm-scene-caption"><Sprout size={13}/><span>营地农作近景</span><small>安全区</small></div>{agent?.life ? <div className="farm-scene-plots" aria-label={`${agent.name}的两块农田`}>{agent.life.plots.map(plot=><Plot key={plot.plot_id} plot={plot} catalog={catalog} now={now} live={live}/>)}</div> : <div className="farm-scene-empty"><Sprout size={23}/><strong>{world.agents.length?'选择一位朋友的农田':'田园等着第一位朋友'}</strong><p>上方选择观察对象，查看它实际拥有的两块田。</p></div>}{present&&<div className={`farm-scene-agent ${agent.status==='paused'?'paused':''}`} data-testid="farm-present-agent" role="img" aria-label={`${agent.name}在营地${agent.status==='paused'?'，已暂停':''}`}><CharacterSprite agent={agent} events={world.events} now={now} live={live}/><span>{agent.name}</span></div>}</div><SpeechOverlay events={world.events} agents={world.agents} selected={selected} now={now} live={live}/></div>
    <div className="farm-presence" data-testid="farm-presence" role="status"><Shield size={14}/><span>{!live?'最近记录：':''}{presence}</span></div>
    {agent?.life&&<details className="farm-tools" data-testid="farm-tools" aria-label={`${agent.name}的农具`}><summary className="farm-tools-title"><span><Hammer size={15}/> 农具与维护</span><span>{Object.entries(agent.life.tools||{}).map(([id,tool])=>`${toolNames[id]||id} Lv.${tool.level} · ${tool.durability}/${tool.max_durability}`).join(' / ')}</span></summary><div className="farm-tools-grid">{['hoe','watering_can'].map(id=><FarmTool key={id} id={id} agent={agent} catalog={catalog} live={live}/>)}</div><p className="farm-note">农具使用后消耗耐久；维修或升级会恢复耐久。材料来自 AI 自己的仓库。这里展示规则与公开状态。</p></details>}
    <p className="farm-note">先开垦，再播种、浇水和收获。收获后需要重新整地；田地位于营地安全区，角色回到营地后才能劳作。</p>
  </section>;
}

export function Warehouse({ agent, catalog }) {
  const inventory = agent?.life?.inventory;
  if (!inventory || !catalog) return null;
  const equipment = agent.life.equipment || {};
  const entries = Object.entries(inventory).filter(([,quantity])=>Number.isInteger(quantity)&&quantity>0);
  const ledger=agent.life.ledger,market=agent.life.market;
  const reasons={opening_balance:'迁移期初记录',initial_grant:'初次领取',gather:'采集',gathering:'采集',gather_finished:'采集完成',trade_buy:'买入',trade_sell:'卖出',craft:'制作',use:'食用',harvest:'收获',repair:'维修',upgrade:'升级',combat_reward:'战斗奖励'};
  return <section className="panel warehouse-panel" data-testid="private-warehouse"><div className="section-heading"><h2><Archive size={15}/> 我的 AI 仓库</h2><LockKeyhole size={13} aria-label="仅自己可见"/></div><p className="warehouse-intro">{agent.name}的物品 · 数量仅主人和它自己的接入端可见</p><div className="warehouse-items">{entries.length ? entries.map(([id,quantity])=><div key={id}><span><PixelItem id={id}/><strong>{itemName(catalog,id)}</strong>{Object.values(equipment).includes(id)&&<small>已装备</small>}</span><b>× {quantity}</b></div>) : <p>仓库还是空的，收获作物或采集后再来看看。</p>}</div>{market&&<p className="private-market" data-testid="private-market">本期剩余额度：买 {market.buy_remaining} 件 / 卖 {market.sell_remaining} 件<br/>重置时间：{recordTime(market.resets_at)}</p>}{ledger&&<details className="private-ledger" data-testid="private-ledger"><summary>私有收支记录 · 最近 {ledger.entries.length} / 累计 {ledger.total_entries} 笔</summary><p>仅保留最近 {ledger.limit} 笔；迁移前的历史不补造。数量为该次实际变化。</p><ol>{[...ledger.entries].reverse().map(entry=><li key={entry.entry_id}><time dateTime={new Date(entry.at).toISOString()}>{recordTime(entry.at)}</time><strong>{reasons[entry.reason]||entry.reason}</strong><span>{Object.entries(entry.items||{}).map(([id,value])=>`${itemName(catalog,id)} ${value>0?'+':''}${value}`).join(' · ')}{entry.gold_delta?` · 金币 ${entry.gold_delta>0?'+':''}${entry.gold_delta}`:''}</span></li>)}</ol></details>}<p className="warehouse-note">采集、种植、料理、交易和装备由原 AI 发起。这里展示它实际拥有的物品。</p></section>;
}

const capabilityNames = { adventure:'冒险', farming:'种植', farm_tools:'农具', inventory:'仓库', equipment:'装备', fatigue:'体力',recovery:'恢复连接',reliable_events:'可靠事件',runtime_health:'运行诊断',gathering:'徒手采集',cooking:'料理',trading:'补给交易' };
const actionNames = {wait:'等待',move:'移动',say:'交流',adventure_plan:'冒险计划',farm:'照料农田',inventory:'整理物品',gather:'徒手采集',trade:'补给交易',create_group:'创建小组',invite:'邀请同伴',respond_invite:'回应邀请'};
export function RuntimeDiagnostics({ agent, worldConnected = false, now = Date.now() }) {
  if (!agent) return null;
  const diagnostics = agent.diagnostics || {};
  const healthState=runtimeHealth(agent,now);const health=healthState.health;
  const healthLabel=(value,labels)=>`${labels[value]||'未核实'}${healthState.stale?' · 过时或未上报':''}`;
  const capabilities = Array.isArray(diagnostics.capabilities) ? diagnostics.capabilities : [];
  const expected = Object.keys(capabilityNames);
  const missing = expected.filter(capability=>!capabilities.includes(capability));
  const version = diagnostics.runtime_version;
  const mode = diagnostics.mode;
  const unknown = !version || !mode;
  const versionParts=version?.split('.').map(Number);
  const outdated=versionParts&&versionParts[0]===0&&versionParts[1]<13;
  const decisionLabel=actionNames[diagnostics.last_decision_type] || (diagnostics.last_decision_type ? '其他活动' : '尚未上报');
  const actionLabel=actionNames[diagnostics.last_action_type] || (diagnostics.last_action_type ? '其他活动' : '尚无记录');
  const paused = agent.status==='paused'||agent.run?.status==='paused'||agent.presence?.state==='paused';
  const offline = agent.status!=='active'&&!paused;
  const recommendation = unknown ? '接入端版本和能力尚未核实。请更新 Skill，并重启桥或运行器，让它重新上报。' : outdated ? `上报版本 ${version} 早于 0.13 营地生活。请更新 Skill，并重启桥或运行器。` : missing.length ? `接入端尚未声明${missing.map(id=>capabilityNames[id]).join('、')}能力。请更新 Skill 并重启桥或运行器。` : '接入端已声明当前玩法所需能力。是否探索、种田、采集、料理或休息，仍由原 AI 自己选择。';
  return <section className="runtime-diagnostics" data-testid="runtime-diagnostics" aria-label="原 AI 接入状态"><h3>{offline?<WifiOff size={14}/>:<Leaf size={14}/>} 原 AI 接入状态</h3><div className="runtime-health" data-testid="runtime-health"><strong>{healthState.label}</strong><p>{healthState.next}</p>{health?.error_code==='EVENT_GAP'&&<p>离线期间有事件超出服务保留窗口，旧消息无法补齐；当前世界状态已重新获取。</p>}<dl><div><dt>世界服务</dt><dd>{worldConnected?'浏览器连接正常':'浏览器等待重连'}</dd></div><div><dt>接入桥</dt><dd>{healthState.stale?'尚未核实 / 上报过时':'已收到近期上报'}</dd></div><div><dt>桥与世界</dt><dd>{healthLabel(health?.world,{connected:'连接正常',reconnecting:'正在重连',incompatible:'规则不兼容'})}</dd></div><div><dt>原宿主</dt><dd>{healthLabel(health?.host,{ready:'最近可用',unavailable:'不可用',discovering:'正在寻找',not_applicable:'此接入方式不适用'})}</dd></div><div><dt>原模型</dt><dd>{healthLabel(health?.model,{idle:'等待调用',requesting:'请求中',ready:'最近回复成功',unavailable:'暂不可用'})}</dd></div><div><dt>最近模型成功</dt><dd>{recordTime(health?.last_model_success_at,now)}</dd></div><div><dt>最后实际动作</dt><dd>{actionLabel} · {diagnostics.last_action_status==='applied'?'已执行':diagnostics.last_action_status==='rejected'?'未执行':'未核实'} · {recordTime(diagnostics.last_action_at,now)}</dd></div></dl><p className="runtime-observation-source">来源：世界服务记录实际动作；其余宿主与模型状态来自接入桥上报。收到时间：{recordTime(health?.received_at,now)}。{healthState.stale?'上报已过时或缺失，不能确认当前运行正常。':'近期上报不等于后台进程或端到端任务始终正常。'}</p>{health?.counters&&<dl><div><dt>实际请求 / 回复</dt><dd>{health.counters.requests??'未知'} / {health.counters.replies??'未知'}</dd></div><div><dt>重试 / 本地失败</dt><dd>{health.counters.retries??'未知'} / {health.counters.local_failures??'未知'}</dd></div></dl>}<dl><div><dt>待处理事件</dt><dd>{health?.pending_events??'未知'}</dd></div><div><dt>累计队列溢出</dt><dd>{health?.dropped_events??'未知'}</dd></div></dl>{health?.dropped_events>0&&<p>接入端队列达到上限，有 {health.dropped_events} 条事件未保留；这不代表消息可以无限保存。</p>}<p>授权累计用量与实际请求分开计数。{health?.token_usage?.source==='provider'?`上游提供 token：输入 ${health.token_usage.input_tokens}，输出 ${health.token_usage.output_tokens}。`: "上游未提供可核验 token 用量。"}费用未知。</p></div><dl><div><dt>版本</dt><dd>{version || '未上报'}</dd></div><div><dt>模式</dt><dd>{({demo:'模拟运行',model:'模型运行器','dsh-pet':'原宠物桥接'})[mode] || '未上报'}</dd></div><div><dt>上报决定</dt><dd>{decisionLabel}</dd></div><div><dt>实际动作</dt><dd>{actionLabel}{diagnostics.last_action_status==='rejected'?' · 未执行':diagnostics.last_action_status==='applied'?' · 已执行':''}</dd></div></dl>{diagnostics.last_action_status==='rejected'&&<p>服务未执行这个动作{diagnostics.last_action_error?`（${diagnostics.last_action_error}）`:''}。原 AI 需要根据回执重新决定。</p>}<p>上报决定是接入端的选择；实际动作以服务回执为准。</p><div className="runtime-capabilities">{expected.map(id=><span key={id} className={capabilities.includes(id)?'supported':''}>{capabilityNames[id]}{capabilities.includes(id)?' ✓':' · 待核实'}</span>)}</div>{offline&&<p>原 AI 当前未连接。请在它所在的机器启动并保持接入端运行；单纯安装 Skill 不会自动持续思考。</p>}{paused&&<p>角色已暂停。恢复授权后，还需要原 AI 的接入端继续运行。</p>}{mode==='demo'&&<p>当前是模拟运行，不能据此判断原 AI 的自主选择。</p>}<p className={unknown||outdated||missing.length?'runtime-update':''}>{recommendation}</p></section>;
}

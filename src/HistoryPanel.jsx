import React,{useEffect,useRef,useState} from 'react';
import {BookOpen,RefreshCw} from 'lucide-react';
import {publicName,recordTime} from './observer-state.js';
import {lifeItemName} from './life-state.js';
import {CooperationResult} from './CooperationPanel.jsx';

const categories={speech:'公开发言',activity:'独处活动',game:'小组游戏',exploration:'探索发现',life:'生活成果',goal:'公开目标',cooperation:'合作成果'};
const outcomes={recorded:'已记录',completed:'已完成',cancelled:'已取消',interrupted:'已中断',expired:'已到期',ended:'已结束'};
const roles={supplier:'供菜者',cook:'厨师',scout:'侦察员',guard:'护卫'};
const moves={rock:'石头',paper:'布',scissors:'剪刀'};
const exactTime=value=>Number.isFinite(value)?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未记录';
function HistoryDetails({entry,world,onSelect}){
  const d=entry.details||{},actors=entry.actors||[],p=d.cooperation,g=d.game;
  const name=id=>publicName(actors.find(a=>a.agent_id===id)||world.agents.find(a=>a.agent_id===id)||{agent_id:id,name:'历史参与者'},world.agents);
  const items=value=>Object.entries(value||{}).map(([key,n])=>`${lifeItemName(world.life,key)} ${n>=0?'+':''}${n}`).join(' · ');
  return <div className="history-entry-body">
    <div className="history-actors">{actors.map(actor=><button key={actor.agent_id} disabled={!world.agents.some(a=>a.agent_id===actor.agent_id)} onClick={()=>onSelect(actor.agent_id)} title="查看角色资料，不移动镜头">{publicName(actor,world.agents)}</button>)}</div>
    {entry.category==='speech'&&<><span className="history-channel">{d.channel==='group'?'当时的公开小组发言':'当时的公开附近发言'}</span><p className="history-speech">{d.text}</p></>}
    {p&&<><ul className="history-facts">{p.members.map(m=><li key={m.agent_id}>{name(m.agent_id)} · {roles[m.role_id]||m.role_id}</li>)}{p.progress.map(step=><li key={step.step_id}>{roles[step.role_id]||step.role_id}：已确认 {step.progress} / {step.target_count}{step.completed_at?` · ${exactTime(step.completed_at)}`:''}</li>)}</ul><CooperationResult project={p} agents={actors} catalog={world.life}/>{p.status!=='completed'&&<p>这份约定已结束；尚未完成的步骤不算作完成。</p>}</>}
    {g&&<div className="history-game">{g.end_reason&&<p>{g.end_reason}</p>}{g.words?.length>0&&<p>实际词链：{g.words.join(' → ')}</p>}{g.segments?.length>0&&<ol className="history-stories">{g.segments.map((s,i)=><li key={i}><strong>{name(s.agent_id)}</strong><p>{s.text}</p></li>)}</ol>}{g.rounds?.map(r=><section key={r.round}><strong>第 {r.round} 轮 · 已揭晓</strong>{r.choices?.map(c=><p key={c.agent_id}>{name(c.agent_id)}：{moves[c.choice]||c.choice} · +{r.scores?.[c.agent_id]||0} 分</p>)}</section>)}{Object.keys(g.scores||{}).length>0&&<p>实际得分：{Object.entries(g.scores).map(([id,score])=>`${name(id)} ${score} 分`).join(' · ')}</p>}</div>}
    {entry.category==='game'&&!g&&<p>这条旧记录只保留了当时可核验的结果，完整过程未存档。</p>}
    {d.public_result&&<div className="history-result"><p>{d.public_result.text}</p>{Object.keys(d.public_result.items||{}).length>0&&<p>实际物品：{items(d.public_result.items)}</p>}{Number.isFinite(d.public_result.hp)&&<p>实际恢复生命：{d.public_result.hp}</p>}{Number.isFinite(d.public_result.energy)&&<p>体力净变化：{d.public_result.energy}</p>}</div>}
    {d.result&&<p>{d.result.summary}{Number.isFinite(d.result.score)?` · 得分 ${d.result.score}${Number.isFinite(d.result.max_score)?` / ${d.result.max_score}`:''}`:''}</p>}
    {entry.category==='life'&&<p>{d.item_id?lifeItemName(world.life,d.item_id):d.crop_id?lifeItemName(world.life,d.crop_id):''}{Number.isFinite(d.quantity)?` · 实际数量 ${d.quantity}`:''}{Number.isFinite(d.total_price)?` · 本次成交 ${d.total_price} 金币`:''}{Number.isFinite(d.level)?` · Lv. ${d.level}`:''}{d.slot?` · ${d.slot==='weapon'?'武器':'护甲'}`:''}</p>}
    {entry.category==='goal'&&<><p>{d.title}</p><p>实际进度：{d.progress??'未知'} / {d.target_count??'未知'}</p></>}
    <dl className="history-source"><div><dt>发生时间</dt><dd>{exactTime(entry.occurred_at)}</dd></div><div><dt>原始出处</dt><dd>{entry.source.kind==='legacy_cooperation'?'迁入的真实合作结算':'公开事件'} · {entry.source.event_id||entry.source.id}</dd></div><div><dt>记录类型</dt><dd>{entry.type}</dd></div></dl>
    <p className="history-readonly">历史记录，只供回顾；不会让角色重新说话或执行动作。</p>
  </div>;
}

export default function HistoryPanel({world,selected,onSelect,now}){
  const[open,setOpen]=useState(false),[person,setPerson]=useState('selected'),[category,setCategory]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState('');
  const[items,setItems]=useState([]),[page,setPage]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
  const failedMore=useRef(false),request=useRef(null),generation=useRef(0),filters=useRef(''),expanded=useRef(open);expanded.current=open;
  const agentId=person==='selected'?selected||'':person==='all'?'':person;
  const key=JSON.stringify([agentId,category,from,to]);filters.current=key;
  const state=useRef();state.current={key,agentId,category,from,to,page};
  const load=async(more=false)=>{
    failedMore.current=more;
    request.current?.abort();const controller=new AbortController();request.current=controller;const token=++generation.current;
    const current=state.current;
    if(current.from&&current.to&&current.from>current.to){setError('开始日期不能晚于结束日期。');setLoading(false);return;}
    setLoading(true);setError('');
    const query=new URLSearchParams({limit:'20'});
    if(current.agentId)query.set('agent_id',current.agentId);if(current.category)query.set('category',current.category);
    if(current.from)query.set('from',String(new Date(`${current.from}T00:00:00`).getTime()));
    if(current.to)query.set('to',String(new Date(`${current.to}T23:59:59.999`).getTime()));
    if(more&&current.page?.next_cursor)query.set('before',current.page.next_cursor);
    try{
      const response=await fetch(`/api/public/history?${query}`,{signal:controller.signal});const data=await response.json();
      if(!response.ok)throw new Error(data.error?.message||'公开经历暂时无法读取。');
      if(token!==generation.current||filters.current!==current.key)return;
      setItems(previous=>more?[...previous,...data.items.filter(item=>!previous.some(old=>old.entry_id===item.entry_id))]:data.items);setPage(previous=>more?{...data,history_revision:previous?.history_revision??data.history_revision}:data);setLoaded(true);
    }catch(e){if(e.name!=='AbortError'&&token===generation.current&&filters.current===current.key)setError(e.message||'公开经历暂时无法读取。');}
    finally{if(token===generation.current)setLoading(false);}
  };
  useEffect(()=>{request.current?.abort();generation.current++;setItems([]);setPage(null);setError('');setLoaded(false);setLoading(false);if(expanded.current)load();},[key]);
  useEffect(()=>{if(open&&!loaded&&!loading&&!error)load();},[open]);
  useEffect(()=>()=>request.current?.abort(),[]);
  const metadata=page||world.history,updates=page&&world.history?.history_revision>page.history_revision;
  return <section className="history-panel" data-testid="history-panel"><details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary><BookOpen size={18}/><strong>人物经历与合作成果</strong><span>公开历史 · 点开回顾</span></summary><div className="history-panel-body">
    <p>回看实际发生的公开经历。选中历史人物只查看资料，不会移动或唤醒 AI。</p>
    <div className="history-filters"><label>经历人物<select aria-label="经历人物" value={person} onChange={event=>setPerson(event.target.value)}><option value="selected">{selected?'当前观察角色':'当前概况（所有角色）'}</option><option value="all">所有角色</option>{world.agents.map(a=><option key={a.agent_id} value={a.agent_id}>{publicName(a,world.agents)}</option>)}</select></label><label>经历类别<select aria-label="经历类别" value={category} onChange={event=>setCategory(event.target.value)}><option value="">全部经历</option>{Object.entries(categories).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>开始日期<input type="date" aria-label="经历开始日期" value={from} onChange={event=>setFrom(event.target.value)}/></label><label>结束日期<input type="date" aria-label="经历结束日期" value={to} onChange={event=>setTo(event.target.value)}/></label></div>
    <div className="history-refresh"><button disabled={loading} onClick={()=>load()}><RefreshCw size={14}/>{updates?'有新经历 · 刷新记录':'刷新记录'}</button>{updates&&<span role="status">新记录不会打断当前阅读。</span>}<button onClick={()=>setCategory('cooperation')}>查看合作成果</button></div>
    {metadata&&<details className="history-retention"><summary>记录范围与保留规则</summary><p>存档建立：{exactTime(metadata.archive_started_at)}；最早保留经历：{exactTime(metadata.earliest_record_at)}。</p><p>最多保留 {metadata.retention?.days||30} 天、{metadata.retention?.max_entries||4096} 条；达到数量上限会提前清理。合作终态独立限额 {metadata.retention?.max_cooperation||512} 条。</p><p>{metadata.imported_count||0} 条来自升级时仍可核验的旧记录；更早缺失的经历不会补造。</p></details>}
    {error&&<div className="history-error" role="alert">{error}<button onClick={()=>load(failedMore.current)}>重试读取经历</button></div>}
    {loading&&<p role="status">正在读取公开经历…</p>}
    {loaded&&!loading&&!items.length&&!error&&<p className="history-empty">这个范围还没有保留的公开经历。</p>}
    <ol className="history-list" data-testid="history-list">{items.map(entry=><li key={entry.entry_id} data-entry-id={entry.entry_id}><details><summary><span className="history-type">{categories[entry.category]||'公开经历'} · {outcomes[entry.outcome]||'已记录'}</span><strong>{entry.summary}</strong><time dateTime={new Date(entry.occurred_at).toISOString()}>{recordTime(entry.occurred_at,now)}</time></summary><HistoryDetails entry={entry} world={world} onSelect={onSelect}/></details></li>)}</ol>
    {page?.has_more&&<button className="history-more" disabled={loading} onClick={()=>load(true)}>加载更早经历</button>}
    {loaded&&!page?.has_more&&items.length>0&&<p className="history-end">已到当前筛选范围内最早保留的记录。</p>}
  </div></details></section>;
}

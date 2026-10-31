import React from 'react';
import {Users} from 'lucide-react';
import {cooperationCatalog,cooperationSummary} from './cooperation-state.js';
import {publicName,recordTime} from './observer-state.js';
import {lifeItemName} from './life-state.js';

export function CooperationResult({project,agents=[],catalog}) {
  const name=id=>publicName(agents.find(a=>a.agent_id===id)||{agent_id:id,name:'已接受成员'},agents);
  return project.public_result?<div className="cooperation-result" data-testid="cooperation-result"><strong>共同结果</strong><p>{project.public_result.text}</p>{Object.entries(project.public_result.items_by_agent||{}).map(([id,items])=><p key={id}>{name(id)}：{Object.entries(items).map(([item,quantity])=>`${lifeItemName(catalog,item)} +${quantity}`).join(' · ')}</p>)}</div>:null;
}

export default function CooperationPanel({world,agent,now,live}) {
  const state=cooperationSummary(world,agent?.agent_id,live?now:world.server_time||now);
  if(!state)return null;
  const p=state.project,catalog=cooperationCatalog(world,p);
  const name=id=>publicName(world.agents.find(a=>a.agent_id===id)||{agent_id:id,name:'已接受成员'},world.agents);
  const roles=catalog?.roles||p.members.map(m=>({role_id:m.role_id,name:m.role_id}));
  const terms=typeof catalog?.terms==='string'?[catalog.terms]:Array.isArray(catalog?.terms)?catalog.terms.filter(t=>typeof t==='string'):[];
  return <section className="cooperation-section" aria-label="所选角色的公开合作"><details className="cooperation-card" key={p.cooperation_id} data-testid="cooperation-panel" data-cooperation-status={p.status}>
    <summary><Users size={20} aria-hidden="true"/><span><strong>{state.name}</strong><span>{!live?'最近记录 · ':''}{state.label}</span></span><small>{p.status==='proposed'?`${p.members.length} / 2 位已接受`:p.status==='needs_review'?`${state.confirmed} / ${p.members.length} 位已复核`:`${p.members.length} 位自愿成员`}</small></summary>
    <div className="cooperation-body">
      <p className="cooperation-consent">{!live?'以下是最近收到的约定，重连前无法确认当前状态。':state.awaiting?'本地计时已到，正在等待服务器确认；这里不会自动宣布完成或结束。':p.status==='proposed'?'发起者正在征询同伴。未接受的对象与回复不会公开；沉默不代表同意或拒绝。':p.status==='needs_review'?'合作需要双方各自复核；已确认进度保留，复核不会延长期限或自动执行工作。':p.status==='active'?'成员已明确接受分工。接受约定不代表正在执行，具体行动仍由各自 AI 决定。':p.status==='completed'?'以下是服务器确认的共同结果。完成不会自动开始下一次合作。':'这份约定已经结束。已发生的实际结果保留，不将未完成阶段算作完成。'}</p>
      <ul className="cooperation-members" aria-label="已接受的合作分工">{roles.map(role=>{const member=p.members.find(m=>m.role_id===role.role_id);return <li key={role.role_id}><strong>{role.name}</strong><span>{member?name(member.agent_id):'尚未有人接受'}</span>{p.status==='needs_review'&&member&&<small>{member.confirmed?'已复核':'等待本人复核'}</small>}{role.description&&<p>{role.description}</p>}</li>;})}</ul>
      <ol className="cooperation-steps" aria-label="服务器已确认的合作进度">{state.steps.map((step,index)=>{const spec=catalog?.steps?.find(s=>s.step_id===step.step_id),member=p.members.find(m=>m.role_id===step.role_id);return <li key={step.step_id}><div><strong>阶段 {index+1} · {spec?.description||step.step_id}</strong><span>{step.progress} / {step.target_count}</span></div><progress aria-label={`${spec?.description||step.step_id}已确认进度`} value={step.progress} max={step.target_count}/><small>{step.completed_at?`已确认完成 · ${recordTime(step.completed_at,now)}`:member?`${name(member.agent_id)}的约定分工，尚未确认完成`:'等待成员明确接受'}</small></li>;})}</ol>
      {p.template_id==='camp_meal'&&<p className="cooperation-escrow">约定中已提交的共享萝卜：<strong>{p.escrow?.turnip??0}</strong>。这是本次合作的托管物资，不代表任何人的仓库余额。</p>}
      <dl className="journey-facts"><div><dt>建立时间</dt><dd>{recordTime(p.created_at,now)}</dd></div>{p.status==='proposed'&&<div><dt>征询截止</dt><dd>{recordTime(p.invite_expires_at,now)}</dd></div>}<div><dt>固定截止</dt><dd>{recordTime(p.expires_at,now)}</dd></div>{p.started_at&&<div><dt>成立时间</dt><dd>{recordTime(p.started_at,now)}</dd></div>}{p.ended_at&&<div><dt>结束时间</dt><dd>{recordTime(p.ended_at,now)}</dd></div>}</dl>
      <CooperationResult project={p} agents={world.agents} catalog={world.life}/>
      {terms.length>0&&<details className="cooperation-terms"><summary>这份约定的公开规则</summary>{terms.map((term,i)=><p key={i}>{term}</p>)}</details>}
      <p className="journey-note">进度仅来自成立后服务器确认的有效行动。旁观者只能阅读；私人邀请、拒绝内容和主人要求不会在这里显示。</p>
    </div>
  </details></section>;
}

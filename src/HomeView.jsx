import React, { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, Home, Lamp, MessageCircle, X } from 'lucide-react';
import { CharacterSprite, usePixelNow } from './PixelWorld.jsx';
import { SpeechBubbles } from './SpeechOverlay.jsx';
import { publicName, recordTime } from './observer-state.js';
import { CottageArt, FurnitureArt, RoomArt, SouvenirArt } from './home-art.jsx';
import { furnitureNames, furnitureSize, homeActorProxy, homeActors, homePoint, homePosition, souvenirNames } from './home-state.js';
import './homes.css';
import { projectMapPoint } from './map-projection.js';

export function HomeEntrance({ world, map, onClick }) {
  const entrance = world.home_rules?.entrance;
  if (!entrance || !onClick) return null;
  return <button className="home-world-entrance" style={{ ...projectMapPoint(entrance, map), zIndex: 95 + entrance.y * 10 }} onClick={onClick}
    data-testid="home-world-entrance" aria-label={`旁观家园入口，广场坐标 ${entrance.x}, ${entrance.y}`} title="查看小屋 · 只切换旁观画面">
    <svg viewBox="0 0 54 68" aria-hidden="true"><ellipse cx="27" cy="63" rx="20" ry="4" fill="#354d3440"/><g fill="none" stroke="#52422e" strokeWidth="2.2" strokeLinejoin="round"><path d="M13 16v46h5V16" fill="#9e794b"/><path d="m4 9 34-2 12 14-12 15-34-2Z" fill="#e0c38c"/><path d="m10 21 10-8 10 8m-18-1v9h16v-9m-9 9v-6h4v6" strokeWidth="1.5"/><path d="M35 19h8m-4-4 4 4-4 4" strokeWidth="1.5"/></g></svg><span>小屋入口</span>
  </button>;
}

function HomeActor({ agent, world, selected, onSelect, now, live }) {
  const proxy = homeActorProxy(agent);
  const clock = usePixelNow(now, live && agent.status === 'active', proxy);
  const position = homePosition(agent, clock, live && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!position) return null;
  const name = publicName(agent, world.agents);
  return <button className={`home-actor ${selected === agent.agent_id ? 'selected' : ''}`} style={{ ...homePoint(position), zIndex: 30 + position.y * 10 }}
    data-testid={`home-actor-${agent.agent_id}`} data-home-id={agent.home_presence.home_id} data-speech-agent={agent.agent_id}
    data-foot-x={position.x} data-foot-y={position.y} aria-label={`查看${name}的公开档案`} onClick={() => onSelect(agent.agent_id)}>
    <CharacterSprite agent={proxy} now={now} live={live}/><span>{name}</span>
  </button>;
}

function PlacedFurniture({ item, display, rules, active, onDisplay }) {
  const [width, height] = furnitureSize(item, rules);
  const style = { left: `${(70 + item.x * 50) / 640 * 100}%`, top: `${(135 + item.y * 42 - 20) / 540 * 100}%`,
    width: `${width * 50 / 640 * 100}%`, height: `${(height * 42 + 20) / 540 * 100}%`, zIndex: item.kind === 'rug' ? 1 : 20 + (item.y + height) * 10 };
  const art = <FurnitureArt kind={item.kind} vertical={[90, 270].includes(item.rotation)} item={display?.item_id}/>;
  return display ? <button className={`home-furniture home-exhibit ${active ? 'selected' : ''}`} style={style} data-testid={`home-furniture-${item.instance_id}`} data-furniture-kind={item.kind}
    aria-label={`查看纪念品：${display.title || souvenirNames[display.item_id] || '陈列物'}`} aria-expanded={active} aria-controls="home-display-detail" onClick={() => onDisplay(display.display_id)}>{art}<span className="home-exhibit-mark"><BookOpen size={11}/></span></button>
    : <div className="home-furniture" style={style} data-testid={`home-furniture-${item.instance_id}`} data-furniture-kind={item.kind} role="img" aria-label={furnitureNames[item.kind] || '家具'}>{art}</div>;
}

export default function HomeView({ world, home, requestedHome, selected, onSelect, onHome, now, live, grid }) {
  const [displayId, setDisplayId] = useState(null);
  useEffect(() => setDisplayId(null), [home?.home_id]);
  const homes = world.homes || [], rules = world.home_rules || world.rules?.homes;
  const present = homeActors(world.agents, home?.home_id);
  const owner = world.agents.find(agent => agent.agent_id === home?.owner_agent_id);
  const focused = world.agents.find(agent => agent.agent_id === selected);
  const display = home?.displays?.find(item => item.display_id === displayId);
  const homeEvents = (world.events || []).filter(event => event.payload?.home_id === home?.home_id);
  const setDisplay = id => setDisplayId(previous => previous === id ? null : id);
  return <section className="home-view" data-testid="home-view" aria-labelledby="home-view-title">
    <header className="home-heading"><div><span className="home-eyebrow">A LITTLE PLACE OF THEIR OWN</span><h2 id="home-view-title"><Home size={19}/>{home?.name || '我的小家'}</h2><p>{home ? `${owner ? publicName(owner, world.agents) : '原屋主'}的小屋 · ${!live ? '最近记录 · ' : ''}${present.length} 位在屋内` : '留一盏灯，收藏自己的故事。'}</p></div><span className="home-readonly"><Lamp size={14}/>安静旁观</span></header>
    {home ? <><div className="home-interior-layout"><div className="home-interior-canvas">
      <div className="home-room" data-testid="home-room" data-home-id={home.home_id} aria-label={`${home.name}室内，10乘8格，门口通往广场`}>
        <RoomArt grid={grid}/>
        {(home.furniture || []).map(item => <PlacedFurniture key={item.instance_id} item={item} rules={rules} display={home.displays?.find(value => value.instance_id === item.instance_id)} active={display?.instance_id === item.instance_id} onDisplay={setDisplay}/>)}
        {present.map(agent => <HomeActor key={agent.agent_id} agent={agent} world={world} selected={selected} onSelect={onSelect} now={now} live={live}/>)}
        {!home.furniture?.length && <div className="home-room-empty" data-testid="home-room-empty"><strong>还没开始布置</strong><span>一间空屋，等它慢慢变成家。</span></div>}
        <span className="home-door-caption">门口 · 广场</span>
        <SpeechBubbles events={homeEvents} agents={present} selected={selected} now={now} live={live} sceneId="plaza"/>
      </div>
      <div className="home-room-note" role="status"><span>{!live ? '连接中断 · 仅显示最近确认的布置和位置。' : present.length ? '只显示实际在这间小屋内的屋主和访客。' : '此刻屋内无人，家具与故事都还在。'}</span><span>{home.furniture?.length || 0} 件家具 · {home.displays?.length || 0} 件纪念品</span></div>
      </div>
      <div className="home-life-panels">
        <section className="home-display-panel" aria-labelledby="home-displays-title"><h3 id="home-displays-title"><BookOpen size={16}/> 留下来的小事 <span>{home.displays?.length || 0}</span></h3>
          {home.displays?.length ? <div className="home-display-buttons">{home.displays.map(item => <button key={item.display_id} className={item.display_id === displayId ? 'selected' : ''} onClick={() => setDisplay(item.display_id)} aria-expanded={item.display_id === displayId} aria-controls="home-display-detail"><SouvenirArt item={item.item_id}/><span><strong>{item.title || souvenirNames[item.item_id] || '陈列物'}</strong><small>{souvenirNames[item.item_id] || '纪念品'} · 阅读题注</small></span><ArrowUpRight size={14}/></button>)}</div> : <p className="home-quiet-copy">展架还没有收藏。AI 可以把真正拥有的物品留在这里，写下它自己的题注。</p>}
          {display && <article className="home-display-detail" id="home-display-detail" data-testid="home-display-detail" aria-label="纪念品题注"><button className="home-detail-close" aria-label="收起纪念品题注" onClick={() => setDisplayId(null)}><X size={16}/></button><SouvenirArt item={display.item_id}/><div><h4>{display.title || souvenirNames[display.item_id] || '陈列物'}</h4><p>{display.text || '屋主没有为这件纪念品写下题注。'}</p><small>陈列于 {recordTime(display.placed_at, now)}</small></div></article>}
        </section>
        <section className="home-message-panel" aria-labelledby="home-messages-title"><h3 id="home-messages-title"><MessageCircle size={16}/> 门边留言簿 <span>{home.messages?.length || 0}</span></h3>
          {home.messages?.length ? <ol className="home-messages" data-testid="home-messages">{[...home.messages].reverse().map(message => <li key={message.message_id}><div><strong>{message.author_name || '来访的朋友'}</strong><time>{recordTime(message.created_at, now)}</time></div><p>{message.text}</p></li>)}</ol> : <p className="home-quiet-copy">留言簿还是空白。屋主和受邀来访的 AI 可以亲自留下几句话。</p>}
        </section>
      </div></div>
    </> : <div className="home-unbuilt" data-testid="home-unbuilt"><CottageArt/><div><h3>{requestedHome ? '这间小屋暂时不可见' : focused ? `${publicName(focused, world.agents)}还没有建造小屋` : '这里还没有选中的小屋'}</h3><p>{requestedHome ? '服务器的公开记录里没有这间小屋。可以从下方房屋入口看看邻居的家。' : '建造、布置、邀请谁来坐坐，都由原 AI 自己决定。旁观者的切换不会让它搬家或移动。'}</p>{!homes.length && <span>等第一位 AI 用自己的材料建造小屋。</span>}</div></div>}
    {!!homes.length && <nav className="home-neighborhood" aria-label="公开房屋入口"><div className="home-neighborhood-heading"><h3>沿着小路，看看邻居的家</h3><span>{homes.length} 间小屋</span></div><div className="home-entrances">{homes.map(item => <button key={item.home_id} className={home?.home_id === item.home_id ? 'selected' : ''} onClick={() => onHome(item.home_id)} aria-pressed={home?.home_id === item.home_id} aria-label={`旁观小屋：${item.name}`}><CottageArt small/><span><strong>{item.name}</strong><small>{homeActors(world.agents, item.home_id).length} 位在屋内 · {item.displays?.length || 0} 件纪念品</small></span><ArrowUpRight size={16}/></button>)}</div></nav>}
    <p className="home-autonomy-note">房间里的每件家具、题注与留言来自 AI 的真实行动。它可以布置自己的小屋、接受邀请或离开；这个窗口只负责看见。</p>
  </section>;
}

import React, { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, Home, Lamp, MessageCircle, Armchair, Utensils, Moon, PenLine, X } from 'lucide-react';
import { usePixelNow } from './PixelWorld.jsx';
import { HomeCharacter } from './HomeCharacter.jsx';
import HomeBooks from './HomeBooks.jsx';
import { SpeechBubbles } from './SpeechOverlay.jsx';
import { publicName, recordTime } from './observer-state.js';
import { BookArt, CottageArt, FurnitureArt, HomeSignArt, RoomArt, SouvenirArt, WritingArt, furnitureArtSpec } from './home-art.jsx';
import { homePixelContactHeight } from './home-pixel-pose.js';
import { furnitureNames, furnitureSize, furnitureUses, homeActivity, homeActivityNames, homeFurnitureOccupant, homeActorProxy, homeActors, homePoint, homePosition, homeSeatAnchor, homeUsePresentationStyle, souvenirNames } from './home-state.js';
import { homeActorDepth, homeFurnitureLayout } from './home-pixel-layout.js';
import './homes.css';
import { AquariumDetails } from './AquariumArt.jsx';
import './leisure.css';
import { projectMapPoint } from './map-projection.js';

export function HomeEntrance({ world, map, onClick }) {
  const entrance = world.home_rules?.entrance;
  if (!entrance || !onClick) return null;
  return <button className="home-world-entrance" style={{ ...projectMapPoint(entrance, map), zIndex: 95 + entrance.y * 10 }} onClick={onClick}
    data-testid="home-world-entrance" aria-label={`旁观家园入口，广场坐标 ${entrance.x}, ${entrance.y}`} title="查看小屋 · 只切换旁观画面">
    <HomeSignArt/><span>小屋入口</span>
  </button>;
}

function HomeActor({ agent, home, world, selected, onSelect, now, live }) {
  const proxy = homeActorProxy(agent);
  const clock = usePixelNow(now, live && agent.status === 'active', proxy);
  const position = homePosition(agent, clock, live && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!position) return null;
  const name = publicName(agent, world.agents);
  const activity = homeActivity(agent, clock), furniture = home.furniture.find(item => item.instance_id === activity?.instance_id);
  const using = activity?.phase === 'using', enabled = live && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const artSpec = furniture && furnitureArtSpec(furniture.kind);
  const seat = homeSeatAnchor(proxy, furniture, artSpec);
  const presentationStyle = homeUsePresentationStyle(proxy, furniture, clock, enabled, undefined, artSpec, homePixelContactHeight(activity,furniture,seat?.facing));
  const depth = homeActorDepth(position, seat ? homeFurnitureLayout(furniture, world.home_rules, artSpec) : null);
  return <><button className={`home-actor ${selected === agent.agent_id ? 'selected' : ''} ${using ? 'using-furniture' : ''}`} style={{ ...homePoint(position), zIndex: depth }}
    data-testid={`home-actor-${agent.agent_id}`} data-home-id={agent.home_presence.home_id} data-speech-agent={agent.agent_id}
    data-foot-x={position.x} data-foot-y={position.y} data-home-phase={activity?.phase} data-home-activity={activity?.kind} data-home-furniture={activity?.instance_id} aria-label={`查看${name}的公开档案${activity ? `，${activity.label}` : ''}`} onClick={() => onSelect(agent.agent_id)}>
    <HomeCharacter agent={proxy} activity={activity} furniture={furniture} artSpec={artSpec} now={clock} live={live} presentationStyle={presentationStyle}/>
  </button><div className={`home-actor-label ${selected === agent.agent_id ? 'selected' : ''}`} style={{ ...homePoint(position), ...presentationStyle }} aria-hidden="true"><span className="home-actor-name">{name}</span>{activity && <span className="home-activity-badge">{activity.phase === 'approaching' ? '走向家具' : homeActivityNames[activity.kind]}</span>}</div></>;
}

function PlacedFurniture({ item, display, book, rules, active, onDisplay, onBook, onFurniture, occupant, live }) {
  const spec = furnitureArtSpec(item.kind), layout = homeFurnitureLayout(item, rules, spec);
  const state = occupant?.home_presence.activity?.phase;
  const seated = occupant && homeSeatAnchor(homeActorProxy(occupant), item, spec);
  const writing = state === 'using' && occupant?.home_presence.activity.kind === 'write';
  const kind = book ? 'book' : display ? 'display' : 'furniture';
  const click = book ? () => onBook(book.book_id) : display ? () => onDisplay(display.display_id) : () => onFurniture(item.instance_id);
  const label = book ? `阅读架上作品：${book.title}` : display ? `查看纪念品：${display.title || souvenirNames[display.item_id] || '陈列物'}` : `查看家具：${furnitureNames[item.kind] || '家具'}`;
  return <>
    <button className={`home-furniture ${book || display ? 'home-exhibit' : 'home-furniture-inspect'} ${book ? 'home-book-furniture' : ''} ${active ? 'selected' : ''} ${state ? 'occupied' : ''}`} style={layout.style}
      data-testid={`home-furniture-${item.instance_id}`} data-furniture-kind={item.kind} data-use-phase={state} data-render-layer={item.kind === 'rug' ? 'floor' : 'furniture'}
      data-rotation={layout.rotation} data-foot-x={item.x} data-foot-y={item.y} data-render-width={layout.width} data-render-height={layout.height}
      aria-label={label} aria-expanded={active} aria-controls={`home-${kind}-detail`} onClick={click}>
      <FurnitureArt kind={item.kind} rotation={layout.rotation} layer="base" item={item.kind==='aquarium'?item:display?.item_id} live={live}/>
      {(book || display) && <span className="home-exhibit-mark"><BookOpen size={12}/></span>}
      {book && <BookArt className="home-shelf-book"/>}
      {writing && <WritingArt className={`home-table-writing ${live && occupant.status === 'active' ? 'writing-live' : ''}`} data-testid="home-table-writing"/>}
      {state && <span className="home-furniture-use-dot" aria-hidden="true"/>}
    </button>
    {seated && <span className="home-furniture-foreground" data-occludes-agent={occupant.agent_id} data-furniture-instance={item.instance_id} style={{ ...layout.style, zIndex: layout.foregroundDepth }} aria-hidden="true">
      <FurnitureArt kind={item.kind} rotation={layout.rotation} layer="foreground"/>
    </span>}
  </>;
}
const activityIcons = { sit: Armchair, eat: Utensils, read: BookOpen, rest: Moon, write: PenLine };

function HomeActivityPanel({ agent, home, world, now, live }) {
  const activity = homeActivity(agent, now);
  if (!activity) return null;
  const furniture = home.furniture.find(item => item.instance_id === activity.instance_id), Icon = activityIcons[activity.kind];
  const reading = activity.phase === 'using' ? activity.reading : null;
  return <section className="home-now" aria-label="小屋里正在发生" data-testid="home-current-activity" data-phase={activity.phase}>
    <div className="home-now-title"><Icon size={17}/><div><span>{publicName(agent, world.agents)}</span><strong>{activity.phase === 'approaching' ? `走向${furnitureNames[furniture?.kind] || '家具'}` : `${homeActivityNames[activity.kind]} · ${furnitureNames[furniture?.kind] || '家具旁'}`}</strong></div><small>{!live ? '最近记录' : activity.phase === 'approaching' ? '正在走过去' : activity.remaining === 0 ? '等待确认结束' : `${activity.remaining ?? '—'} 秒`}</small></div>
    {activity.phase === 'using' && <progress max="1" value={activity.progress} aria-label="家具使用进度"/>}
    <p>{activity.phase === 'approaching' ? '沿屋内通路走到家具旁，抵达后才开始。' : activity.kind === 'eat' ? '这次进餐使用它自己的食物。' : activity.kind === 'rest' ? '歇一会儿，再由它自己决定接下来做什么。' : activity.kind === 'write' ? `正在写《${activity.title || '未题名作品'}》，完成后才会公开正文。` : activity.kind === 'read' ? '翻开一篇真实作品，安静读一会儿。' : '在自己的步调里坐一会儿。'}</p>
    {reading && <details className="home-reading" data-testid="home-reading"><summary><BookOpen size={14}/>{reading.title || '正在阅读'}</summary><p tabIndex={0} role="region" aria-label="正在阅读的原文，可滚动阅读">{reading.text}</p><small>{reading.author_name ? `${reading.author_name} · ` : ''}{reading.source || '广场原创'}</small></details>}
  </section>;
}

function FurnitureDetail({ item, rules, occupant, agents, onClose }) {
  if (!item) return null;
  const definition = rules?.furniture_catalog?.[item.kind], size = furnitureSize(item, rules), uses = rules?.use_version === 1 ? definition?.activities || furnitureUses[item.kind] || [] : [];
  const cost = Object.entries(definition?.cost || {}).map(([id, count]) => `${({ wood: '木材', grass: '干草', ore: '矿石' })[id] || id} × ${count}`).join(' · ');
  return <section id="home-furniture-detail" data-testid="home-furniture-detail" className="home-furniture-detail" aria-label="家具公开信息">
    <button className="home-detail-close" aria-label="收起家具信息" onClick={onClose}><X size={16}/></button>
    <div className="home-furniture-preview"><FurnitureArt kind={item.kind} rotation={item.rotation || 0} item={item.kind==='aquarium'?item:undefined} preview/></div>
    <div><h3>{furnitureNames[item.kind] || '家具'}</h3><p>{uses.length ? uses.map(kind => homeActivityNames[kind]).join(' · ') : item.kind === 'display_shelf' ? '收藏真正拥有的物品，写下自己的题注。' : '由屋主选择的室内布置。'}</p><small>占地 {size[0]} × {size[1]} · {occupant ? `${publicName(occupant, agents)}${occupant.home_presence.activity.phase === 'approaching' ? '正在走来' : '正在使用'}` : '此刻空闲'}</small>{cost && <small>制作材料：{cost}</small>}{item.kind==='aquarium'&&<AquariumDetails item={item}/>}<span className="home-detail-note">仅查看 · 是否使用由 AI 自己决定</span></div>
  </section>;
}

export default function HomeView({ world, home, requestedHome, selected, onSelect, onHome, now, live, grid }) {
  const [displayId, setDisplayId] = useState(null);
  const [bookId, setBookId] = useState(null);
  const [furnitureId, setFurnitureId] = useState(null);
  useEffect(() => { setDisplayId(null); setFurnitureId(null); setBookId(null); }, [home?.home_id]);
  const homes = world.homes || [], rules = world.home_rules || world.rules?.homes;
  const present = homeActors(world.agents, home?.home_id);
  const owner = world.agents.find(agent => agent.agent_id === home?.owner_agent_id);
  const focused = world.agents.find(agent => agent.agent_id === selected);
  const display = home?.displays?.find(item => item.display_id === displayId);
  const furniture = home?.furniture?.find(item => item.instance_id === furnitureId);
  const activeActor = present.find(agent => agent.agent_id === selected && homeActivity(agent, now)) || present.find(agent => homeActivity(agent, now));
  const homeEvents = (world.events || []).filter(event => event.payload?.home_id === home?.home_id);
  const setDisplay = id => { setFurnitureId(null); setDisplayId(previous => previous === id ? null : id); };
  const setFurniture = id => { setDisplayId(null); setFurnitureId(previous => previous === id ? null : id); };
  const dayPhase = world.day_cycle?.phase || 'day';
  return <section className="home-view" data-testid="home-view" aria-labelledby="home-view-title">
    <header className="home-heading"><div><span className="home-eyebrow">A LITTLE PLACE OF THEIR OWN</span><h2 id="home-view-title"><Home size={19}/>{home?.name || '我的小家'}</h2><p>{home ? `${owner ? publicName(owner, world.agents) : '原屋主'}的小屋 · ${!live ? '最近记录 · ' : ''}${present.length} 位在屋内` : '留一盏灯，收藏自己的故事。'}</p></div><span className="home-readonly"><Lamp size={14}/>安静旁观</span></header>
    {home ? <><div className="home-interior-layout"><div className="home-interior-canvas">
      <div className={`home-room home-phase-${dayPhase} ${!live ? 'home-disconnected' : ''}`} data-testid="home-room" data-home-id={home.home_id} aria-label={`${home.name}室内，10乘8格，门口通往广场`}>
        <RoomArt grid={grid} phase={dayPhase}/>
        <span className="home-room-atmosphere" aria-hidden="true"/>
        {(home.furniture || []).map(item => <PlacedFurniture key={item.instance_id} item={item} rules={rules} live={live} book={home.books?.find(value => value.instance_id === item.instance_id)} onBook={id => setBookId(previous => previous === id ? null : id)} display={home.displays?.find(value => value.instance_id === item.instance_id)} active={display?.instance_id === item.instance_id || furnitureId === item.instance_id || home.books?.some(value => value.instance_id === item.instance_id && value.book_id === bookId)} onDisplay={setDisplay} onFurniture={setFurniture} occupant={homeFurnitureOccupant(world.agents, item.instance_id, home.home_id)}/>)}
        {present.map(agent => <HomeActor key={agent.agent_id} agent={agent} home={home} world={world} selected={selected} onSelect={onSelect} now={now} live={live}/>)}
        {!home.furniture?.length && <div className="home-room-empty" data-testid="home-room-empty"><strong>还没开始布置</strong><span>一间空屋，等它慢慢变成家。</span></div>}
        <span className="home-door-caption">门口 · 广场</span>
        <SpeechBubbles events={homeEvents} agents={present} selected={selected} now={now} live={live} sceneId="plaza"/>
      </div>
      <div className="home-room-note" role="status"><span>{!live ? '连接中断 · 仅显示最近确认的布置和位置。' : present.length ? '只显示实际在这间小屋内的屋主和访客。' : '此刻屋内无人，家具与故事都还在。'}</span><span>{home.furniture?.length || 0} 件家具 · {home.displays?.length || 0} 件纪念品</span></div>
      <FurnitureDetail item={furniture} rules={rules} occupant={furniture && homeFurnitureOccupant(world.agents, furniture.instance_id, home.home_id)} agents={world.agents} onClose={() => setFurnitureId(null)}/>
      </div>
      <div className="home-life-panels">
        <HomeActivityPanel agent={activeActor} home={home} world={world} now={now} live={live}/>
        <HomeBooks home={home} selected={bookId} onSelect={setBookId} now={now}/>
        <section className="home-display-panel" aria-labelledby="home-displays-title"><h3 id="home-displays-title"><BookOpen size={16}/> 留下来的小事 <span>{home.displays?.length || 0}</span></h3>
          {home.displays?.length ? <div className="home-display-buttons">{home.displays.map(item => <button key={item.display_id} className={item.display_id === displayId ? 'selected' : ''} onClick={() => setDisplay(item.display_id)} aria-expanded={item.display_id === displayId} aria-controls="home-display-detail"><SouvenirArt item={item.item_id}/><span><strong>{item.title || souvenirNames[item.item_id] || '陈列物'}</strong><small>{souvenirNames[item.item_id] || '纪念品'} · 阅读题注</small></span><ArrowUpRight size={14}/></button>)}</div> : <p className="home-quiet-copy">展架还没有收藏。AI 可以把真正拥有的物品留在这里，写下它自己的题注。</p>}
          {display && <article className="home-display-detail" id="home-display-detail" data-testid="home-display-detail" aria-label="纪念品题注"><button className="home-detail-close" aria-label="收起纪念品题注" onClick={() => setDisplayId(null)}><X size={16}/></button><SouvenirArt item={display.item_id}/><div><h4>{display.title || souvenirNames[display.item_id] || '陈列物'}</h4><p>{display.text || '屋主没有为这件纪念品写下题注。'}</p><small>陈列于 {recordTime(display.placed_at, now)}</small></div></article>}
        </section>
        <section className="home-message-panel" aria-labelledby="home-messages-title"><h3 id="home-messages-title"><MessageCircle size={16}/> 门边留言簿 <span>{home.messages?.length || 0}</span></h3>
          {home.messages?.length ? <ol className="home-messages" data-testid="home-messages" tabIndex={0} aria-label="小屋公开留言，可滚动阅读">{[...home.messages].reverse().map(message => <li key={message.message_id}><div><strong>{message.author_name || '来访的朋友'}</strong><time>{recordTime(message.created_at, now)}</time></div><p>{message.text}</p></li>)}</ol> : <p className="home-quiet-copy">留言簿还是空白。屋主和受邀来访的 AI 可以亲自留下几句话。</p>}
        </section>
      </div></div>
    </> : <div className="home-unbuilt" data-testid="home-unbuilt"><CottageArt/><div><h3>{requestedHome ? '这间小屋暂时不可见' : focused ? `${publicName(focused, world.agents)}还没有建造小屋` : '这里还没有选中的小屋'}</h3><p>{requestedHome ? '服务器的公开记录里没有这间小屋。可以从下方房屋入口看看邻居的家。' : '建造、布置、邀请谁来坐坐，都由原 AI 自己决定。旁观者的切换不会让它搬家或移动。'}</p>{!homes.length && <span>等第一位 AI 用自己的材料建造小屋。</span>}</div></div>}
    {!!homes.length && <nav className="home-neighborhood" aria-label="公开房屋入口"><div className="home-neighborhood-heading"><h3>沿着小路，看看邻居的家</h3><span>{homes.length} 间小屋</span></div><div className="home-entrances">{homes.map(item => <button key={item.home_id} className={home?.home_id === item.home_id ? 'selected' : ''} onClick={() => onHome(item.home_id)} aria-pressed={home?.home_id === item.home_id} aria-label={`旁观小屋：${item.name}`}><CottageArt small/><span><strong>{item.name}</strong><small>{homeActors(world.agents, item.home_id).length} 位在屋内 · {item.displays?.length || 0} 件纪念品</small></span><ArrowUpRight size={16}/></button>)}</div></nav>}
    <p className="home-autonomy-note">房间里的每件家具、题注与留言来自 AI 的真实行动。它可以布置自己的小屋、接受邀请或离开；这个窗口只负责看见。</p>
  </section>;
}

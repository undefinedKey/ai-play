import React, { useContext, useEffect, useRef, useState } from 'react';
import { ChevronDown, MapPin, Megaphone, NotebookPen, Theater, Utensils, X } from 'lucide-react';
import { ResourceSelection } from './Wilderness.jsx';
import { PixelSprite } from './PixelWorld.jsx';
import { RenderSpace } from './world-render-context.jsx';
import { projectMapPoint } from './map-projection.js';
import { recordTime } from './observer-state.js';
import { communityArtwork, communityEvents, communityEventState, communityPerformances, communityPerformanceHistory } from './community-state.js';
import './community.css';

const icons = { picnic: MapPin, table: Utensils, stage: Theater, board: NotebookPen };
const descriptions = { picnic: '铺开野餐垫，一个人也可以坐一会儿。', table: '带上自己准备的食物，走到桌旁用餐。', stage: '讲故事、朗诵或听一段别人的分享。', board: 'AI 自己写下邀约，其他来客自愿报名。' };
function Artwork({ kind, position, depth }) {
  const definition = communityArtwork[kind], anchor = [definition.anchor.x * definition.native_scale, definition.anchor.y * definition.native_scale];
  return <RenderSpace position={position} depth={depth} anchor={anchor}><span className="community-art" style={{ '--community-anchor-x': `${anchor[0]}px`, '--community-anchor-y': `${anchor[1]}px` }}><PixelSprite definition={definition}/></span></RenderSpace>;
}

export function CommunityLandmarks({ world, map }) {
  const selection = useContext(ResourceSelection), community = world.community;
  if (!community?.venues) return null;
  const performance = communityPerformances(world, world.server_time).find(value => value.venue_id === 'stage');
  return <>{community.venues.map(venue => {
    const selected = selection.selected === `community:${venue.id}`, depth = venue.id === 'picnic' || venue.id === 'stage' ? 90 + venue.position.y * 10 : 100 + venue.position.y * 10;
    return <React.Fragment key={venue.id}>
      {(venue.seats || []).filter(seat => !seat.activities.includes('perform')).map(seat => <span key={seat.id} className="community-seat" style={{ ...projectMapPoint(seat.position, map), zIndex: 99 + seat.position.y * 10 }} data-testid={`community-seat-${seat.id}`} data-seat-id={seat.id} aria-hidden="true"><Artwork kind={venue.id === 'picnic' ? 'mat' : 'seat'} position={seat.position} depth={99 + seat.position.y * 10}/></span>)}
      <button type="button" className={`community-landmark community-${venue.id} ${selected ? 'selected' : ''}`} style={{ ...projectMapPoint(venue.position, map), zIndex: depth }} data-testid={`community-landmark-${venue.id}`} data-scene-id="plaza" aria-label={`查看${venue.name}，只读旁观`} aria-expanded={selected} aria-controls="community-board" onClick={() => selection.select(selected ? null : `community:${venue.id}`)}>
        <Artwork kind={venue.id} position={venue.position} depth={depth}/><span className={`community-sign ${venue.id === 'stage' && performance ? 'has-performance' : ''}`}>{venue.id === 'stage' && performance ? performance.title : venue.name}</span>
      </button>
    </React.Fragment>;
  })}</>;
}

function Gathering({ event, community, now, live }) {
  const state = communityEventState(event, now, live), venue = community.venues.find(value => value.id === event.venue_id);
  return <article className={`community-event status-${state.key}`} data-testid={`community-event-${event.event_id}`} data-community-status={state.key}>
    <div className="community-event-top"><span><MapPin size={13}/>{venue?.name || '公共场地'}</span><span>{state.label}</span></div>
    <h4>{event.title}</h4><p className="community-event-author">{event.host_name || '活动发起者'} 发起 · {event.joined_count ?? event.member_agent_ids?.length ?? 0} 位报名</p>
    <p className="community-event-text">{event.text}</p>
    <div className="community-event-foot"><span>{state.deadline || (event.end_reason === 'restarted' ? '服务重启，活动已中止' : '此活动已结束') }</span><time>{recordTime(event.ended_at || event.started_at || event.created_at, now)}</time></div>
    {state.ongoing && <small>报名不等于到场。什么时候开始、做什么，都由参与者决定。</small>}
  </article>;
}
function Performance({ performance, live, now }) {
  return <article className="community-performance" data-testid={`community-${performance.completed ? 'completed' : 'performance'}-${performance.job_id}`}>
    <div className="community-performance-heading"><Theater size={18}/><span>{performance.completed ? `已完成的分享 · ${recordTime(performance.completed_at, now)}` : !live ? '最近收到的舞台记录' : now >= performance.ends_at ? '等待服务器确认结束' : '此刻在舞台上'}</span></div>
    <h4>{performance.title}</h4><p className="community-event-author">{performance.name} · 自主公开的文字</p><blockquote>{performance.text}</blockquote>
  </article>;
}

export default function CommunityBoard({ world, visible, selected, onSelect, now, live }) {
  const [filter, setFilter] = useState('current'), heading = useRef(null), toggle = useRef(null);
  const community = world.community, open = selected === 'community' || selected?.startsWith('community:'), venueId = selected?.startsWith('community:') ? selected.slice('community:'.length) : null;
  useEffect(() => { if (visible && open) heading.current?.focus(); }, [visible, open, venueId]);
  if (!visible || !community?.venues) return null;
  const place = community.venues.find(venue => venue.id === venueId), actualFilter = place?.id === 'board' ? null : place?.id;
  const events = communityEvents(community, filter, actualFilter), current = communityEvents(community), history = communityEvents(community, 'history');
  const performances = communityPerformances(world, now).filter(value => !actualFilter || value.venue_id === actualFilter);
  const completed = !actualFilter || actualFilter === 'stage' ? communityPerformanceHistory(world) : [];
  const close = () => { onSelect(null); toggle.current?.focus(); };
  return <section className={`community-panel ${open ? 'is-open' : ''}`} data-testid="community-panel" aria-label="公共场地与自主活动">
    <button type="button" ref={toggle} className="community-toggle" data-testid="community-toggle" aria-expanded={!!open} aria-controls="community-board" onClick={() => onSelect(open ? null : 'community')}><NotebookPen size={20}/><span><strong>林间会客地</strong><small>{!live ? '最近记录 · ' : ''}{current.length ? `${current.length} 场自发活动` : '野餐、共餐和小舞台'}</small></span><span className="community-toggle-hint">看场地与邀约</span><ChevronDown size={17} aria-hidden="true"/></button>
    <div id="community-board" hidden={!open} onKeyDown={event => { if (event.key === 'Escape') close(); }}>
      <div className="community-heading"><div><p>GATHER IN THE WOODS</p><h3 ref={heading} tabIndex={-1}>{place?.name || '留一处相遇的地方'}</h3></div><button type="button" className="community-close" aria-label="关闭活动公告" onClick={close}><X size={18}/></button></div>
      <p className="community-intro">来到这里坐坐，吃自己带来的食物，或分享一段故事。AI 自己决定发起、参加、离开，也可以独处。</p>
      {!live && <p className="community-stale" role="status">当前显示最近收到的场地记录。连接恢复后才能确认现场状态。</p>}
      <div className="community-venues" role="group" aria-label="查看公共场地">{community.venues.map(venue => {
        const Icon = icons[venue.id] || MapPin, occupied = (venue.seats || []).filter(seat => seat.occupied_by).length;
        return <button type="button" key={venue.id} className="community-venue-card" aria-pressed={place?.id === venue.id} onClick={() => onSelect(place?.id === venue.id ? 'community' : `community:${venue.id}`)}>
          <Icon size={18}/><strong>{venue.name}</strong><span>{descriptions[venue.id]}</span><small>{venue.seats?.length ? `${occupied} / ${venue.seats.length} 处站位已被占用或预约` : '公开邀约 · 不会替 AI 报名'}</small>
        </button>;
      })}</div>
      {performances.length > 0 && <div className="community-performances">{performances.map(performance => <Performance key={performance.job_id} performance={performance} live={live} now={now}/>)}</div>}
      {completed.length > 0 && <details className="community-past-performances"><summary>最近完成的分享 · {completed.length}</summary><div className="community-performances">{completed.map(performance => <Performance key={performance.job_id} performance={performance} live={live} now={now}/>)}</div></details>}
      <div className="community-filters" role="group" aria-label="筛选活动公告"><button type="button" aria-pressed={filter === 'current'} onClick={() => setFilter('current')}>当前邀约 <span>{current.length}</span></button><button type="button" aria-pressed={filter === 'history'} onClick={() => setFilter('history')}>往期活动 <span>{history.length}</span></button>{actualFilter && <button type="button" onClick={() => onSelect('community')}>查看所有场地</button>}</div>
      {events.length ? <div className="community-event-grid" data-testid="community-events">{events.map(event => <Gathering key={event.event_id} event={event} community={community} now={now} live={live}/>)}</div> : <div className="community-empty" data-testid="community-empty"><Megaphone size={25}/><strong>{filter === 'history' ? '这里还没有结束的活动' : '等一份自发的邀约'}</strong><p>没有人举办活动时，场地依然可以使用。</p></div>}
      <p className="community-footnote">只读旁观 · 选场地只切换观察内容，不会移动角色或代替它行动。舞台呈现 AI 明确发表的文字。</p>
    </div>
  </section>;
}

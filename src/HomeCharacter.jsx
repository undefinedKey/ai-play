import React from 'react';
import { CharacterSprite } from './PixelWorld.jsx';
import { CharacterHeldProp } from './CharacterHeldProp.jsx';
import { homeConfirmedFurnitureUse, homeSeatAnchor, homeUsePresentationStyle } from './home-state.js';
import { homePixelAction, homePixelContactHeight } from './home-pixel-pose.js';

/** Only server-confirmed adjacent furniture use changes the visual pose.
 * Original identity, equipment, room position and AI decisions stay intact. */
export function HomeCharacter({ agent, activity, furniture, artSpec, now, live, presentationStyle }) {
  const using=activity?.phase==='using'&&homeConfirmedFurnitureUse(agent,furniture);
  if(!using)return <CharacterSprite agent={agent} now={now} live={live}/>;
  const seat=homeSeatAnchor(agent,furniture,artSpec),facing=seat?.facing||agent.facing||'south';
  const enabled=live&&!document.hidden&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches&&agent.status==='active';
  const elapsed=Math.max(0,Math.min(now,activity.ends_at??now)-activity.started_at);
  const action=homePixelAction(activity,furniture),contactHeight=homePixelContactHeight(activity,furniture,facing);
  const seatStyle=presentationStyle||homeUsePresentationStyle(agent,furniture,now,enabled,undefined,artSpec,contactHeight);
  return <span className="home-use-character" style={seatStyle} data-home-use={activity.kind} data-home-contact-height={contactHeight}>
    <CharacterSprite agent={agent} now={now} live={live} presentation={{action,facing,elapsed,enabled}}/>
    {activity.kind==='eat'&&<CharacterHeldProp value={{kind:'bowl',x:0,y:-13}} facing={facing}/>}
  </span>;
}

const timestamp = value => typeof value === 'number' ? value : Date.parse(value);

export function snapshotPresentationTime(snapshot) {
  const sent=timestamp(snapshot.server_time),simulated=timestamp(snapshot.simulation_time);
  // Network encoding/scheduling can happen a whole tick after positions were
  // settled. Start the display at that simulation, not at the send timestamp.
  return Number.isFinite(simulated)&&simulated<=sent&&sent-simulated<=1000?simulated:sent;
}

export function samplePresentationClock(previous, { serverTime, receivedAt, localTime, actor }) {
  const desired=serverTime+Math.max(0,localTime-receivedAt);
  const uninterrupted=actor?.movement?.version===2&&!actor.action&&!actor.hurt;
  // A newly confirmed attack/hit must use its actual clock immediately; motion
  // smoothing must never skip a short reaction after a delayed packet arrives.
  if(!uninterrupted||!previous?.uninterrupted||localTime<previous.localTime||localTime-previous.localTime>1000)return {time:desired,localTime,uninterrupted};
  const elapsed=localTime-previous.localTime,nominal=previous.time+elapsed,error=desired-nominal;
  // A real clock reset/reconnect is authoritative. A clock ahead of the newest
  // sample must repay its lead within an ordinary broadcast interval, or it
  // expires the 250ms prediction window despite timely packets. Slow down by
  // at most half speed; catch up at at most +10%. Both remain forward-moving.
  if(Math.abs(error)>1000)return {time:desired,localTime,uninterrupted};
  return {time:nominal+Math.max(-elapsed*.5,Math.min(elapsed*.1,error)),localTime,uninterrupted};
}

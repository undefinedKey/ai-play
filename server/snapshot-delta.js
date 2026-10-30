/** Delta for one public SSE subscriber; always computed from filtered snapshots. */
export function snapshotDelta(previous, current) {
  const delta = { server_time: current.server_time };
  for (const [key, value] of Object.entries(current)) {
    if (key !== 'events' && key !== 'server_time' && JSON.stringify(previous[key]) !== JSON.stringify(value)) delta[key] = value;
  }
  const prior = previous.events || [], next = current.events || [];
  const last = prior.at(-1)?.event_id;
  const index = last ? next.findIndex(event => event.event_id === last) : -1;
  if (!prior.length) { if (next.length) delta.events = next; }
  else if (index < 0 || JSON.stringify([...prior, ...next.slice(index + 1)].slice(-150)) !== JSON.stringify(next)) {
    delta.event_reset = true; delta.events = next;
  } else if (index < next.length - 1) delta.events = next.slice(index + 1);
  return delta;
}

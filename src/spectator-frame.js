/** Apply a delta only to the previous frame from the same SSE connection.
 * HTTP polling snapshots may update the display, but are not a delta baseline.
 */
export function mergeSpectatorDelta(previous, update) {
  if (!previous) return null;
  const { event_reset, ...delta } = update;
  return {
    ...previous, ...delta,
    events: event_reset ? (delta.events || []) : [...previous.events, ...(delta.events || [])].slice(-150),
  };
}

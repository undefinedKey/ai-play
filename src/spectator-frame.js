import { applyPatch } from 'fast-json-patch/index.mjs';

export class SpectatorFrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpectatorFrameError';
    this.code = code;
    this.resync = true;
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const frameId = value => typeof value === 'string' && value.length > 0;
const invalid = () => new SpectatorFrameError('SPECTATOR_INVALID_PATCH', 'Invalid spectator delta; a full snapshot is required.');
const reserved = path => typeof path === 'string' && /^\/(?:events|stream_frame_id)(?:\/|$)/.test(path);
const mergedEvents = (previous, update) => (update.event_reset
  ? (update.events || [])
  : [...(previous.events || []), ...(update.events || [])]).slice(-150);

/** Apply a delta only to the previous frame from the same SSE connection.
 * HTTP polling snapshots may update the display, but are not a delta baseline.
 */
export function mergeSpectatorDelta(previous, update) {
  if (update?.protocol === 2) {
    if (!record(previous) || !frameId(previous.stream_frame_id)) {
      throw new SpectatorFrameError('SPECTATOR_BASELINE_MISMATCH', 'No spectator stream baseline; a full snapshot is required.');
    }
    if (!frameId(update.frame_id)) throw invalid();
    // Re-delivery of an already applied frame must not append its events twice.
    if (update.frame_id === previous.stream_frame_id) return previous;
    if (update.base_frame_id !== previous.stream_frame_id) {
      throw new SpectatorFrameError('SPECTATOR_BASELINE_MISMATCH', 'Spectator stream baseline changed; a full snapshot is required.');
    }
    if (!Array.isArray(update.patch) || update.events !== undefined && !Array.isArray(update.events) ||
        update.event_reset !== undefined && typeof update.event_reset !== 'boolean') throw invalid();
    // These fields have a separate transport contract and cannot be patched,
    // tested, copied or moved through the snapshot body.
    if (update.patch.some(operation => !record(operation) || reserved(operation.path) || reserved(operation.from))) throw invalid();
    const { events, stream_frame_id, ...document } = previous;
    let next;
    try {
      next = applyPatch(document, update.patch, true, false, true).newDocument;
    } catch {
      throw invalid();
    }
    if (!record(next) || Object.hasOwn(next, 'events') || Object.hasOwn(next, 'stream_frame_id')) throw invalid();
    return { ...next, events: mergedEvents(previous, update), stream_frame_id: update.frame_id };
  }
  if (!previous) return null;
  const { event_reset, ...delta } = update;
  return {
    ...previous, ...delta,
    events: mergedEvents(previous, update),
  };
}

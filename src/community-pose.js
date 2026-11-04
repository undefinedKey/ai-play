import { sampleHomeUsePose } from './home-use-pose.js';
import { samplePaperDollPose } from './paper-doll-rig.js';
import { communityUseState } from './community-state.js';

/** Shared articulated seating keeps the same body, clothing and world foot.
 * A stage reading uses standing arms and a small speaking gesture; it never
 * invents an utterance or causes another actor to listen. */
export function sampleCommunityPose(actor, now, { enabled = true, facing = 'south', rig = {} } = {}) {
  const use = communityUseState(actor, now);
  if (!use?.using) return samplePaperDollPose(actor, 'idle', now, { enabled: false, facing, rig });
  const kind = use.activity === 'perform' ? 'read' : use.activity === 'listen' ? 'sit' : use.activity;
  const sample = sampleHomeUsePose(actor, { phase: 'using', kind, started_at: use.use_started_at, ends_at: use.ends_at }, now,
    { enabled, facing, rig, furnitureKind: use.activity === 'perform' ? 'table' : 'chair' });
  if (use.activity === 'perform') {
    const nod = sample.playing ? Math.sin(use.elapsed / 1000 * 1.1) * .035 : 0;
    sample.parts.head.rotation += nod;
  }
  return { ...sample, action: use.activity, actionPhase: 'using', communityActivity: use.activity };
}

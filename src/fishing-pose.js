import { samplePaperDollPose } from './paper-doll-rig.js';
import { fishingState } from './fishing-view-state.js';

/** Original body/skin, anchored feet, two articulated arms around the rod. */
export function sampleFishingPose(actor, now, { facing = 'north', enabled = true, rig = {} } = {}) {
  const sample = samplePaperDollPose(actor, 'idle', now, { enabled: false, facing, rig }), state = fishingState(actor, now);
  if (!state?.working) return sample;
  const playing = enabled && actor.status === 'active' && state.remaining > 0, d = sample.dimensions;
  const vertical = facing === 'north' || facing === 'south', mirror = facing === 'west';
  const cast = playing ? Math.max(0, 1 - state.elapsed / 650) : 0;
  for (const side of ['l', 'r']) {
    const sign = side === 'l' ? -1 : 1;
    const root = { x: sign * (vertical ? d.shoulderWidth : 1.5), y: -d.hipHeight - d.torso + 2.5 };
    const target = { x: vertical ? sign * 2 : 7, y: -d.hipHeight + 3 - cast * 7 + (side === 'l' ? 1 : 0) };
    const dx = target.x - root.x, dy = target.y - root.y, distance = Math.hypot(dx, dy), length = Math.max(Math.abs(d.upperArm - d.forearm) + .001, Math.min(d.upperArm + d.forearm - .001, distance));
    const ux = dx / distance, uy = dy / distance, along = (d.upperArm ** 2 - d.forearm ** 2 + length ** 2) / (2 * length), h = Math.sqrt(Math.max(0, d.upperArm ** 2 - along ** 2)), bend = vertical ? sign : -1;
    const elbow = { x: root.x + ux * along + uy * h * bend, y: root.y + uy * along - ux * h * bend }, hand = { x: root.x + ux * length, y: root.y + uy * length };
    const angle = (a, b) => Math.atan2(-(b.x - a.x), b.y - a.y);
    for (const [key, point, rotation] of [[`upper_arm_${side}`, root, angle(root, elbow)], [`forearm_${side}`, elbow, angle(elbow, hand)], [`hand_${side}`, hand, angle(elbow, hand)]]) Object.assign(sample.parts[key], { x: mirror ? -point.x : point.x, y: point.y, rotation: mirror ? -rotation : rotation });
    for (const [key, point] of [[`shoulder_${side}`, root], [`elbow_${side}`, elbow], [`wrist_${side}`, hand]]) sample.joints[key] = { x: mirror ? -point.x : point.x, y: point.y };
  }
  return { ...sample, action: 'fish', playing };
}

import { samplePaperDollPose } from './paper-doll-rig.js';

const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const point = (x, y) => ({ x, y });
const angle = (a, b) => Math.atan2(-(b.x - a.x), b.y - a.y);
const rotate = (p, r) => point(p.x * Math.cos(r) - p.y * Math.sin(r), p.x * Math.sin(r) + p.y * Math.cos(r));
const add = (a, b) => point(a.x + b.x, a.y + b.y);

function limb(root, target, a, b, bend) {
  const dx = target.x - root.x, dy = target.y - root.y, distance = Math.hypot(dx, dy);
  const ux = distance > 1e-8 ? dx / distance : 0, uy = distance > 1e-8 ? dy / distance : 1;
  const length = Math.max(Math.abs(a - b) + 1e-5, Math.min(a + b - 1e-5, distance));
  const along = (a * a - b * b + length * length) / (2 * length);
  const height = Math.sqrt(Math.max(0, a * a - along * along));
  return { root, middle: point(root.x + ux * along + uy * height * bend, root.y + uy * along - ux * height * bend), end: point(root.x + ux * length, root.y + uy * length) };
}

/** Home-only IK. Each pose keeps the original skin, equipment and world foot;
 * knees/arms articulate toward the furniture, not a scaled/rotated sprite.
 * Static accessibility/disconnected views retain the confirmed pose but never
 * advance a bite, page turn or breathing cycle. No gameplay is performed here. */
export function sampleHomeUsePose(actor, activity, now, { facing = 'south', enabled = true, furnitureKind, rig = {} } = {}) {
  const sample = samplePaperDollPose(actor, 'idle', now, { enabled: false, facing, rig });
  if (!activity || activity.phase !== 'using' || !['sit', 'eat', 'read', 'rest', 'write'].includes(activity.kind)) return sample;
  const d = sample.dimensions, mirror = facing === 'west', vertical = ['north', 'south'].includes(facing);
  const time = Math.max(0, Math.min(now, activity.ends_at ?? now) - activity.started_at);
  const playing = enabled && actor.status === 'active' && now < activity.ends_at;
  const entrance = enabled && actor.status === 'active' ? smooth(time / 650) : 1;
  const phase = playing ? time / 1000 : 0;
  const seated = furnitureKind === 'chair' || activity.kind === 'sit';
  const resting = activity.kind === 'rest', reading = activity.kind === 'read', eating = activity.kind === 'eat', writing = activity.kind === 'write', reclining = furnitureKind === 'bed' && resting;
  const breath = playing ? Math.sin(phase * Math.PI * .65) * .22 : 0;
  const hip = point(0, -d.hipHeight + (reclining ? d.hipHeight - 12 : seated ? 7 : resting ? 3 : 0) * entrance + breath);
  const lean = reclining ? -1.1 * entrance : entrance * (resting ? .10 : writing ? .12 : reading ? .055 : .025) * (vertical ? .25 : 1);
  const neck = add(hip, rotate(point(0, -d.torso), lean));
  const headRotation = reclining ? -1.2 * entrance : lean + (resting ? .13 : reading ? .065 : 0) * entrance;
  const parts = sample.parts;
  const set = (key, p, rotation = 0, scaleY = 1) => Object.assign(parts[key], { x: p.x, y: p.y, rotation, scaleY });
  set('hip', hip); set('torso', hip, lean); set('head', neck, headRotation);
  sample.joints.hip = hip; sample.joints.neck = neck;
  const bite = eating && playing ? (1 - Math.cos(phase * Math.PI * .9)) / 2 : 0;
  const turn = reading && playing ? Math.max(0, Math.sin(phase * Math.PI / 4)) ** 8 : 0;
  const stroke = writing && playing ? Math.sin(phase * Math.PI * 1.8) * .8 : 0;
  for (const side of ['l', 'r']) {
    const sign = side === 'l' ? -1 : 1, lateral = sign * (vertical ? d.hipWidth : 1.25);
    const foot = reclining ? point(18 * entrance, mix(-d.sole, -8, entrance)) : point(0, -d.sole), leg = limb(hip, foot, d.thigh, d.shin, 1);
    const project = p => point(lateral + (vertical ? 0 : p.x), p.y + (vertical ? (facing === 'north' ? -1 : 1) * p.x * .45 : 0));
    const upper = project(leg.root), knee = project(leg.middle), ankle = project(leg.end);
    sample.legSpace[side] = Object.fromEntries([['hip', leg.root], ['knee', leg.middle], ['ankle', leg.end]].map(([name, p]) => [name, { depth: p.x, height: -p.y }]));
    set(`thigh_${side}`, upper, angle(upper, knee), Math.hypot(knee.x - upper.x, knee.y - upper.y) / d.thigh);
    set(`shin_${side}`, knee, angle(knee, ankle), Math.hypot(ankle.x - knee.x, ankle.y - knee.y) / d.shin);
    set(`foot_${side}`, ankle, reclining ? -Math.PI / 2 * entrance : 0);
    sample.joints[`hip_${side}`] = upper; sample.joints[`knee_${side}`] = knee; sample.joints[`ankle_${side}`] = ankle;
    const shoulder = add(hip, rotate(point(sign * (vertical ? d.shoulderWidth : 1.5), -d.torso + 2.5), lean));
    let target = point(vertical ? sign * 4 : 5, hip.y + (seated ? 1 : 3));
    if (reading) target = point(vertical ? sign * (3.5 + (side === 'r' ? turn : 0)) : 7, hip.y - 6 - (side === 'r' ? turn : 0));
    if (eating) target = side === 'l' ? point(vertical ? -3 : 5, hip.y - 4) : point(vertical ? mix(4, 2, bite) : mix(8, 5, bite), mix(hip.y - 3, neck.y - 3, bite));
    if (writing) target = point(vertical ? sign * 3 + (side === 'r' ? stroke : 0) : 7 + (side === 'r' ? stroke : 0), hip.y - 4 + (side === 'r' ? Math.abs(stroke) * .3 : 0));
    if (reclining) target = side === 'l' ? point(-5 * entrance, hip.y + 5) : point(0, hip.y + 2);
    const arm = limb(shoulder, target, d.upperArm, d.forearm, vertical ? sign : -1);
    set(`upper_arm_${side}`, arm.root, angle(arm.root, arm.middle)); set(`forearm_${side}`, arm.middle, angle(arm.middle, arm.end)); set(`hand_${side}`, arm.end, angle(arm.middle, arm.end));
    sample.joints[`shoulder_${side}`] = arm.root; sample.joints[`elbow_${side}`] = arm.middle; sample.joints[`wrist_${side}`] = arm.end;
  }
  const defaults = { head: point(0, -d.head * .75), chest: point(0, -d.torso * .55), hand: point(0, 0) };
  for (const [name, parent] of Object.entries({ head: parts.head, chest: parts.torso, hand: parts.hand_r })) {
    const supplied = rig.attachment_offsets?.[name];
    const offset = supplied && Number.isFinite(supplied.x) && Number.isFinite(supplied.y) ? supplied : defaults[name];
    Object.assign(sample.slots[name], add(parent, rotate(offset, parent.rotation)), { rotation: parent.rotation });
  }
  sample.homeProp = reading ? { kind: 'book', x: vertical ? 0 : 7, y: hip.y - 5, tilt: turn * .08 } : eating ? { kind: 'bowl', x: vertical ? 0 : 5, y: hip.y - 2, tilt: 0 } : writing ? { kind: 'writing', x: vertical ? 0 : 7, y: hip.y - 3, tilt: 0, stroke } : null;
  if (mirror) {
    for (const value of [...Object.values(parts), ...Object.values(sample.slots), ...Object.values(sample.joints)]) { value.x = -value.x; if (Number.isFinite(value.rotation)) value.rotation = -value.rotation; }
    if (sample.homeProp) sample.homeProp.x = -sample.homeProp.x;
  }
  return { ...sample, action: activity.kind, actionPhase: 'using', enabled: playing, playing, entrance, seatedHipHeight: d.hipHeight - 7 };
}

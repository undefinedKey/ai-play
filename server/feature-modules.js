import { PEER_MARKET_RULES, initializePeerMarket, publicPeerMarket, peerMarketObservation, tickPeerMarket, endPeerMarket, performPeerMarket } from './peer-market.js';
import { COMMUNITY_RULES, initializeCommunity, publicCommunity, publicCommunityJob, communityObservation, tickCommunity, endCommunity, cancelCommunityUse, performCommunity, communityJob } from './community.js';
import { JOURNEY_RULES, initializeJourney, publicJourney, publicJourneyJob, journeyObservation, tickJourney, endJourney, cancelJourney, performJourney, journeyJob } from './journey.js';
import { WARDROBE_RULES, AQUARIUM_RULES, initializeLifestyle, publicWardrobe, wardrobeObservation, aquariumObservation, performWardrobe, performAquarium } from './lifestyle.js';

// Explicit adapters for two existing world services, not a runtime plugin loader.
// Each service owns its state, validation, public projection and lifecycle. Hooks
// always receive the live World: rejected commands replace world.state atomically.
const MODULES = Object.freeze([
  Object.freeze({
    id: 'wardrobe', rules: WARDROBE_RULES, initialize: initializeLifestyle, perform: performWardrobe,
    publicWorld: () => ({ version: 1 }), publicAgent: a => ({ wardrobe: publicWardrobe(a) }), observe: wardrobeObservation,
    tick: () => false, detach: () => {}, passive: p => p.intent === 'browse',
  }),
  Object.freeze({
    id: 'aquarium', rules: AQUARIUM_RULES, initialize: () => {}, perform: performAquarium,
    publicWorld: () => ({ version: 1 }), observe: aquariumObservation,
    tick: () => false, detach: () => {}, passive: p => ['browse', 'inspect'].includes(p.intent), managesEconomy: true,
  }),
  Object.freeze({
    id: 'journey', rules: JOURNEY_RULES,
    initialize: initializeJourney, perform: performJourney,
    publicWorld: publicJourney, observe: journeyObservation,
    publicAgent: a => ({ journey_job: publicJourneyJob(a) }),
    tick: tickJourney, detach: endJourney, cancelUse: cancelJourney, job: journeyJob,
    passive: p => ['browse', 'stop'].includes(p.intent),
    busy: { code: 'JOURNEY_BUSY', message: '正在执行本人选择的森林行程；可等待或用 journey stop 结束，下一步由本人决定' },
  }),
  Object.freeze({
    id: 'peer_market', rules: PEER_MARKET_RULES,
    initialize: initializePeerMarket, perform: performPeerMarket,
    publicWorld: publicPeerMarket, observe: peerMarketObservation,
    tick: tickPeerMarket, detach: (world, a) => endPeerMarket(world, a), detachOnlyOnLeave: true,
    passive: p => ['browse', 'cancel', 'decline'].includes(p.intent),
    managesEconomy: true,
  }),
  Object.freeze({
    id: 'community', rules: COMMUNITY_RULES,
    initialize: initializeCommunity, perform: performCommunity,
    publicWorld: publicCommunity, observe: communityObservation,
    publicAgent: a => ({ community_job: publicCommunityJob(a) }),
    tick: tickCommunity, detach: endCommunity, cancelUse: cancelCommunityUse,
    job: communityJob,
    passive: p => ['browse', 'join', 'leave', 'start', 'end', 'cancel', 'cancel_use'].includes(p.intent),
    busy: { code: 'COMMUNITY_BUSY', message: '正在执行本人选择的公共场地活动；可等待或用 community cancel_use 结束，下一步由本人决定' },
  }),
]);

const concurrentAction = (type, p) => ['wait', 'say', 'personal_goal'].includes(type)
  || type === 'inventory' && p.intent === 'use'
  || type === 'survival' && p.intent === 'torch'
  || type === 'cooperation' && ['respond', 'confirm', 'leave', 'claim_return'].includes(p.intent);

/**
 * World-facing lifecycle seam. No authorization, receipts, timing loop, or model
 * policy lives here. A finite job owns only its matching movement and publishes
 * its next physical transition; World settles that instant before survival costs.
 * All public values come from explicit module projections, never raw stored jobs.
 */
export function createFeatureModules(world) {
  const byAction = new Map(MODULES.map(module => [module.id, module]));
  const jobs = a => MODULES.flatMap(module => {
    const job = module.job?.(a);
    return job ? [{ module, job }] : [];
  });
  return Object.freeze({
    actions: Object.freeze([...byAction.keys()]),
    initialize(options) { for (const module of MODULES) module.initialize(world, options); },
    rules() { return Object.fromEntries(MODULES.map(module => [module.id, structuredClone(module.rules)])); },
    publicWorld() { return Object.fromEntries(MODULES.map(module => [module.id, module.publicWorld(world)])); },
    publicAgent(a) { return Object.assign({}, ...MODULES.map(module => module.publicAgent?.(a) || {})); },
    observation(a) { return Object.fromEntries(MODULES.map(module => [module.id, module.observe(world, a)])); },
    has(type) { return byAction.has(type); },
    passive(type, payload) { return byAction.get(type)?.passive(payload) === true; },
    managesEconomy(type) { return byAction.get(type)?.managesEconomy === true; },
    perform(a, type, payload, fail, actionId) { return byAction.get(type).perform(world, a, payload, fail, actionId); },
    allows(a, type, payload) {
      return !jobs(a).length || concurrentAction(type, payload) || byAction.get(type)?.passive(payload) === true;
    },
    filterObservation(a, observation) {
      if (!jobs(a).length) return observation;
      const allowed = row => {
        const action = row.action || row;
        return this.allows(a, action.type, action.payload || {});
      };
      // Only contract-defined opportunity arrays at the observation boundary.
      // Do not recursively rewrite world facts, quoted text, or actor records.
      const result = { ...observation };
      if (Array.isArray(result.opportunities)) result.opportunities = result.opportunities.filter(allowed);
      for (const [key, value] of Object.entries(result)) {
        if (value && !Array.isArray(value) && Array.isArray(value.opportunities))
          result[key] = { ...value, opportunities: value.opportunities.filter(allowed) };
      }
      if (result.movement && !this.allows(a, 'move', {})) result.movement = { ...result.movement, candidates: [] };
      return result;
    },
    guard(a, type, payload, fail) {
      if (this.allows(a, type, payload)) return;
      const { module } = jobs(a)[0]; fail(module.busy.code, module.busy.message);
    },
    activity(a) {
      const active = jobs(a);
      return {
        active: active.length > 0,
        expiresAt: Math.min(Infinity, ...active.map(({ job }) => job.expires_at)),
        transitions: active.map(({ job }) => job.phase === 'approaching' ? a.movement?.ends_at : job.ends_at),
      };
    },
    cancelUses(a, reason) {
      let changed = false;
      for (const { module } of jobs(a)) changed = module.cancelUse(world, a, reason) || changed;
      return changed;
    },
    detach(a, { leaveField = true, reason = 'interrupted' } = {}) {
      for (const module of MODULES) {
        if (module.detachOnlyOnLeave && !leaveField) continue;
        if (!leaveField && module.cancelUse) module.cancelUse(world, a, reason);
        else module.detach(world, a, reason);
      }
    },
    tick(survivalFrames) {
      let changed = false;
      for (const module of MODULES) changed = module.tick(world, survivalFrames) || changed;
      return changed;
    },
  });
}

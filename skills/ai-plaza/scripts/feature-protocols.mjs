// Portable protocol adapters. Validation, discovery and event relevance use the
// same concrete feature definitions in standalone hosts and the MCP server.
import { validPeerMarket, supportsPeerMarket, PEER_MARKET_GUIDANCE, peerMarketEventRelevant } from './peer-market-context.mjs';
import { validCommunity } from './community-contract.mjs';
import { supportsCommunity, COMMUNITY_GUIDANCE, communityEventRelevant } from './community-context.mjs';
import { validJourney } from './journey-contract.mjs';
import { supportsJourney, JOURNEY_GUIDANCE, journeyEventRelevant } from './journey-context.mjs';

const adapters = Object.freeze({
  peer_market: Object.freeze({ validate: validPeerMarket, supports: supportsPeerMarket, guidance: PEER_MARKET_GUIDANCE, relevant: peerMarketEventRelevant,
    error: '集市动作须使用明确报价、合法物品、本人意图与当前单据版本' }),
  community: Object.freeze({ validate: validCommunity, supports: supportsCommunity, guidance: COMMUNITY_GUIDANCE, relevant: communityEventRelevant,
    error: '公共场地动作须使用当前场地、座位、公告及该意图的明确字段' }),
  journey: Object.freeze({ validate: validJourney, supports: supportsJourney, guidance: JOURNEY_GUIDANCE, relevant: journeyEventRelevant,
    error: '横版旅程须选择真实路段、目标和该意图的字段；不能把观众镜头当作位置' }),
});

export const FEATURE_ACTIONS = Object.freeze(Object.keys(adapters));
export const featureProtocol = type => adapters[type] || null;
export const featureGuidance = rules => FEATURE_ACTIONS.filter(type => adapters[type].supports(rules)).map(type => adapters[type].guidance).join('\n');
export function relevantFeatureEvent(event, selfId, sceneId) {
  const type = FEATURE_ACTIONS.find(type => event.type?.startsWith(type + '_'));
  return type ? adapters[type].relevant(event, selfId, sceneId) : null;
}

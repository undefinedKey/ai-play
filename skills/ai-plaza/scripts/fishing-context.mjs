// One explicit, finite fishing intention. Public opportunities never pick for AI.
const id = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
export const FISHING_ID_FIELDS = ['spot_id', 'bait_id'];
export function supportsFishing(rules = {}) { return rules.fishing?.version === 1 && rules.allowed_actions?.includes('fish') === true; }
export function validFishing(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (p.intent === 'cancel') return Object.keys(p).length === 1;
  return p.intent === 'start' && id(p.spot_id) && p.bait_id === 'fish_bait' &&
    (p.mode === undefined || ['walk', 'run'].includes(p.mode)) &&
    Object.keys(p).every(key => ['intent', 'spot_id', 'bait_id', 'mode'].includes(key));
}
export const FISHING_GUIDANCE = '仅rules.fishing.version=1且允许fish时可自主钓鱼。fish{intent:start,spot_id,bait_id:fish_bait,mode?:walk|run}选真实完整机会，一次有限行动先走到水边再抛竿；self.fishing.phase=approaching或fishing，wait继续当前一次，fish{intent:cancel}停止，不重复start、不自动再钓。鱼竿、饵、耐久、可用水岸和真实渔获读规则/观察，缺材料可自选采集、制作或其他玩法。结果重新交原AI选择，不代造心情、记忆或行程。';
export function fishingEventRelevant(event, selfId) {
  return ['fish_finished', 'fish_cancelled'].includes(event.type) && event.payload?.agent_id === selfId;
}
export function fishingPromptNotice(context = {}) {
  const { observation: o = {}, rules = {}, events = [] } = context, self = o.self || {};
  if (!supportsFishing(rules) || self.home_presence || self.home_travel) return '';
  if (self.fishing) {
    const job = self.fishing, end = job.ends_at ?? job.expires_at;
    const seconds = Number.isFinite(end) ? Math.max(0, Math.ceil((end - (o.server_time ?? Date.now())) / 1000)) : null;
    return `当前钓鱼[水岸,阶段,余秒]=${JSON.stringify([job.spot_id, job.phase, seconds])}；approaching接近/fishing抛竿。wait续本次，fish{intent:cancel}停止；勿重复start，不自动再钓。\n`;
  }
  if (self.fatigue?.energy <= (rules.fatigue?.tired_at ?? 20) || self.activity || self.adventure?.plan || self.life?.gathering || self.survival?.travel || self.movement ||
    self.adventure?.encounter?.status === 'pending' || o.cooperation && !['completed', 'ended'].includes(o.cooperation.status) || o.cooperation_invitations?.length ||
    o.game && !['finished', 'ended'].includes(o.game.status) && o.game.participants?.includes(self.agent_id) ||
    self.survival && (self.survival.satiety <= (rules.survival?.hungry_at ?? 30) || self.survival.light?.lit === false) ||
    events.some(e => /^(adventure_danger|adventure_aggro|adventure_defeated|fatigue_exhausted|survival_warning|cooperation_)/.test(e.type))) return '';
  const choices = (o.fishing?.opportunities || []).map(o => o?.action || o);
  const choice = choices.find(a => a?.type === 'fish' && validFishing(a.payload) && a.payload.intent === 'start');
  if (choice) return `也可自愿钓鱼：一次先走到水边再抛竿，用自己的鱼竿和饵，不自动续钓；完整动作${JSON.stringify(choice)}。\n`;
  const preparation = choices.find(a => a?.type === 'inventory' && ['craft', 'repair', 'upgrade'].includes(a.payload?.intent) &&
    ['fishing_rod', 'fish_bait'].includes(a.payload?.item_id) && (a.payload.item_id === 'fishing_rod' || a.payload.intent === 'craft') &&
    Object.keys(a.payload).every(key => ['intent', 'item_id'].includes(key)));
  return preparation ? `钓鱼也是可选玩法，尚需自己准备；服务当前合法完整动作${JSON.stringify(preparation)}。不自动制作或接着钓，仍由你选择。\n` : '';
}

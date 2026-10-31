// Server facts and action grammar only; this module never chooses or runs a task.
export const supportsSurvival = (observation, rules) => rules?.survival?.version === 1 &&
  rules.allowed_actions?.includes('survival') && observation?.survival?.version === 1 && !!observation.self?.survival;
export const SURVIVAL_GUIDANCE = 'survival是实际饱食/光源/黑暗风险，不是人格。satiety越低越饿；rest不补饱，inventory use食物按satiety_restore恢复。夜暗无光或饱食归零时主动休息不能恢复生命/体力，返回营地也不自动生火进食。夜晚所有场景含营地暗处有危险，火光只防黑暗不免怪伤。按真实day_cycle、danger_in_seconds、火把/火源余秒自主准备过夜，可吃饭、采木、制作、靠近光源、建火或等；不自动执行固定流程。survival{intent:approach,site_id,mode?:walk|run}只同图有限走到站点，不建火；build{site_id,kind:campfire|firepit}须已近旁；fuel{fire_id,item_id:wood|grass|pine_cone,quantity:1..5}邻近公共添柴，燃尽可重燃；extinguish{fire_id}仅建造者；torch{lit:boolean}点灭自有火把；cancel只有intent停止前往。所有参数均放payload且加intent，使用当前实际ID，不替同伴消耗库存。配方材料/站点、光照半径/燃料上限读服务目录。靠近/建造接受不等于已经安全，重新观察实际light。失联或暂停不能代替原AI吃饭、添柴、采集或恢复任务。';

export function validSurvival(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
  const fields = { approach: ['intent', 'site_id', 'mode'], build: ['intent', 'site_id', 'kind'],
    fuel: ['intent', 'fire_id', 'item_id', 'quantity'], extinguish: ['intent', 'fire_id'], torch: ['intent', 'lit'], cancel: ['intent'] }[p.intent];
  if (!fields || Object.keys(p).some(key => !fields.includes(key))) return false;
  if (p.intent === 'approach') return id(p.site_id) && (p.mode === undefined || ['walk', 'run'].includes(p.mode));
  if (p.intent === 'build') return id(p.site_id) && ['campfire', 'firepit'].includes(p.kind);
  if (p.intent === 'fuel') return id(p.fire_id) && ['wood', 'grass', 'pine_cone'].includes(p.item_id) && Number.isSafeInteger(p.quantity) && p.quantity >= 1 && p.quantity <= 5;
  if (p.intent === 'extinguish') return id(p.fire_id);
  if (p.intent === 'torch') return typeof p.lit === 'boolean';
  return true;
}

const left = (end, now) => Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : null;
const num = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
export function survivalPromptNotice(observation = {}, rules = {}, compact = false, events = []) {
  if (!supportsSurvival(observation, rules)) return '';
  const own = observation.self, s = own.survival, now = observation.server_time ?? observation.survival.server_time;
  const calm = compact === 'critical' && s.light?.lit && !s.darkness_seconds && !s.torch && !s.travel && s.satiety > (rules.survival.hungry_at ?? 30);
  let notice = calm ? `生存:饱${num(s.satiety)}/100，有光；夜暗营地有险，rest需光且饱>0。\n` :
    `生存[饱0~100,光,暗秒,险余秒,火把亮/秒]=${JSON.stringify([num(s.satiety), !!s.light?.lit, num(s.darkness_seconds), num(s.danger_in_seconds), s.torch ? [!!s.torch.lit, num(s.torch.fuel_seconds)] : null])}；夜暗营地也危险，rest需亮且饱>0。\n`;
  const preparation = events.findLast(e => e.type === 'survival_warning' && e.payload?.agent_id === own.agent_id && e.payload.kind === 'prepare_night');
  if (preparation && Number.isFinite(preparation.payload.deadline)) notice += `服务提醒距入夜${left(preparation.payload.deadline, now)}秒，自选准备。\n`;
  if (s.protected_until > now) notice += `救援保护余${left(s.protected_until, now)}秒。\n`;
  if (s.travel) notice += `正前往火点${s.travel.site_id}，期限${left(s.travel.expires_at, now)}秒；仅走不建，survival{intent:cancel}可停。\n`;
  const bag = own.life?.inventory || {};
  if (compact === 'critical') return notice + (!s.light?.lit && (bag.torch > 0 || s.torch?.fuel_seconds > 0) ? `自有火把可survival{intent:torch,lit:true}。\n` : '');
  const distance = p => Math.abs((p?.x ?? 0) - (own.position?.x ?? 0)) + Math.abs((p?.y ?? 0) - (own.position?.y ?? 0));
  const fires = (observation.survival.fires || []).filter(f => f.scene_id === own.scene_id).sort((a, b) => distance(a.position) - distance(b.position));
  const sites = (observation.survival.sites || []).filter(site => site.scene_id === own.scene_id).sort((a, b) => distance(a.interaction_position) - distance(b.interaction_position));
  const fireRows = fires.slice(0, compact ? 1 : 3).map(f => [f.fire_id, f.site_id, f.lit, num(f.fuel_seconds), f.light_radius, distance(f.position) <= 1, f.owner_agent_id === own.agent_id]);
  const siteRows = sites.slice(0, compact ? 1 : 3).map(site => [site.id, site.interaction_position?.x, site.interaction_position?.y]);
  if (fireRows.length) notice += `火[id,点,亮,燃秒,半径,近,己建]=${JSON.stringify(fireRows)}；survival{intent:fuel,fire_id,item_id:wood|grass|pine_cone,quantity:1..5}近才添，熄火可重燃；extinguish仅己建。\n`;
  if (siteRows.length && !s.travel) notice += `火点[id,x,y]=${JSON.stringify(siteRows)}；survival{intent:approach,site_id,mode?:walk|run}只走不建；近才survival{intent:build,site_id,kind:campfire|firepit}。\n`;
  notice += `己有[木,草,矿,松果,火把]=${JSON.stringify(['wood', 'grass', 'ore', 'pine_cone', 'torch'].map(id => bag[id] || 0))}；survival{intent:torch,lit:true|false}点灭自有火把。\n`;
  const structures = rules.survival.structures?.map(f => [f.id, f.ingredients, f.initial_fuel_seconds, f.max_fuel_seconds, f.light_radius]);
  if (structures?.length) notice += `建造[类,材料,初燃秒,上限,光半径]=${JSON.stringify(structures)}；添1燃秒=${JSON.stringify(rules.survival.fuels)}。\n`;
  const torchRecipe = (observation.life || rules.life)?.recipes?.find(r => r.item_id === 'torch');
  if (torchRecipe) notice += `火把inventory{intent:craft,item_id:torch}便携材料${JSON.stringify(torchRecipe.ingredients)}，燃${rules.survival.torch?.fuel_seconds}秒。\n`;
  if (!compact) notice += '光防黑暗不免怪伤；只选一次行动，不自动备夜。\n';
  return notice;
}

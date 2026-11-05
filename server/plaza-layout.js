import { PLAZA_LAYOUT_VERSION } from '../shared/plaza-layout.js';
import { isWalkable, nearestWalkable } from './spatial.js';

// Only an installed layout transition may repair newly blocked plaza origins.
// Ordinary valid positions (including cardinal fractional movement) stay exact.
// Private room coordinates and every other scene are outside this migration.
export function initializePlazaLayout(world, { restore = false } = {}) {
  const oldVersion=world.state.plaza_layout_version;
  if(oldVersion===PLAZA_LAYOUT_VERSION) return [];
  const transitions=[];
  if(restore) for(const a of Object.values(world.state.agents)) {
    if(a.scene_id!=='plaza') continue;
    const original={...a.position},preserved=isWalkable('plaza',original),position=preserved?original:nearestWalkable('plaza',original);
    const record={version:1,from_layout_version:oldVersion||'plaza-pre036',layout_version:PLAZA_LAYOUT_VERSION,
      at:world.now(),reason:preserved?'position_preserved':'terrain_repair',from_position:original,position:{...position},
      from_movement_id:typeof a.movement?.movement_id==='string'?a.movement.movement_id:null};
    a.position={...position}; a.movement=null; a.plaza_layout_migration=record;
    transitions.push({agent_id:a.agent_id,name:a.name,...record});
  }
  world.state.plaza_layout_version=PLAZA_LAYOUT_VERSION;
  return transitions;
}
export function announcePlazaMigration(world, transitions) {
  for(const {version,at,...record} of transitions) world.event('plaza_layout_migrated',{
    ...record,scene_id:'plaza',text:record.reason==='position_preserved'?'广场布局已更新，原位置保留；旧行程已停止，请本人重新决定。':'广场布局已更新，原位置因新实体占地调整到最近合法格；旧行程已停止，请本人重新决定。',
  },[record.agent_id]);
}

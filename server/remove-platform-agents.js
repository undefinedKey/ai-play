/** Remove only legacy built-in roles, never user roles with the same names. */
export function removePlatformAgents(world) {
  const removed = Object.values(world.state.agents).filter(agent => agent.is_platform === true).map(agent => agent.agent_id);
  if (!removed.length) return removed;
  const before = structuredClone(world.state);
  const ids = new Set(removed);
  const controllerIds = new Set(Object.values(world.state.controllers).filter(controller => ids.has(controller.agent_id)).map(controller => controller.controller_id));
  const referencesRemoved = value => {
    if (typeof value === 'string') return ids.has(value) || controllerIds.has(value);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => ids.has(key) || controllerIds.has(key) || referencesRemoved(child));
  };
  world.db.exec('CREATE TABLE IF NOT EXISTS world_migration_backups (migration TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  world.db.exec('BEGIN IMMEDIATE');
  try {
    world.db.prepare('INSERT OR IGNORE INTO world_migration_backups(migration,payload) VALUES(?,?)').run('v0.7-remove-platform-agents', JSON.stringify(before));
    for (const id of ids) delete world.state.agents[id];
    for (const id of controllerIds) delete world.state.controllers[id];
    for (const collection of ['receipts', 'controlReceipts', 'invitations']) {
      for (const [key, value] of Object.entries(world.state[collection])) {
        if (removed.some(id => key.startsWith(id + ':')) || referencesRemoved(value)) delete world.state[collection][key];
      }
    }
    world.state.events = world.state.events.filter(event => !referencesRemoved(event.payload));
    for (const event of world.state.events) event.recipients = event.recipients.filter(id => !ids.has(id));
    for (const [id, group] of Object.entries(world.state.groups)) {
      if (!group.members.some(member => ids.has(member))) continue;
      group.members = group.members.filter(member => !ids.has(member));
      if (group.members.length < 2) {
        for (const member of group.members) if (world.state.agents[member]?.group_id === id) world.state.agents[member].group_id = null;
        delete world.state.groups[id];
      }
    }
    if (referencesRemoved(world.state.game)) world.state.game = null;
    world.save();
    world.db.exec('COMMIT');
  } catch (error) {
    world.db.exec('ROLLBACK');
    world.state = before;
    throw error;
  }
  return removed;
}

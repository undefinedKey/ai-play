/** Complete the cross-database boundary before exposing an HTTP listener after restart.
 * Only roles explicitly marked by the invitation claim path are candidates for cleanup.
 * No raw invitation code, device secret or bearer token is retained in the marker.
 */
export function recoverAgentInvitations(world, accounts) {
  if (!accounts) return;
  const orphans = new Set(); let changed = false;
  for (const agent of Object.values(world.state.agents)) {
    if (!agent.invitation_claim) continue;
    if (!accounts.getOwner(agent.owner_id)) orphans.add(agent.agent_id);
    else delete agent.invitation_claim;
    changed = true;
  }
  if (!changed) return;
  const controllers = new Set(Object.values(world.state.controllers).filter(controller => orphans.has(controller.agent_id)).map(controller => controller.controller_id));
  for (const id of orphans) delete world.state.agents[id];
  for (const id of controllers) delete world.state.controllers[id];
  for (const [key, receipt] of Object.entries(world.state.receipts)) if (controllers.has(receipt.controller_id) || [...orphans].some(id => key.startsWith(id + ':'))) delete world.state.receipts[key];
  for (const key of Object.keys(world.state.controlReceipts)) if ([...orphans].some(id => key.startsWith(id + ':'))) delete world.state.controlReceipts[key];
  world.state.events = world.state.events.filter(event => ![event.payload?.agent_id, event.payload?.from_agent_id, event.payload?.target_agent_id].some(id => orphans.has(id)));
  for (const event of world.state.events) event.recipients = event.recipients.filter(id => !orphans.has(id));
  for (const [id, invitation] of Object.entries(world.state.invitations)) if (orphans.has(invitation.from_agent_id) || orphans.has(invitation.target_agent_id)) delete world.state.invitations[id];
  for (const [id, group] of Object.entries(world.state.groups)) {
    group.members = group.members.filter(id => !orphans.has(id));
    if (!group.members.length) delete world.state.groups[id];
  }
  world.commit();
}

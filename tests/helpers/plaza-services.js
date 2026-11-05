// Fixture placement follows the same published service locations as clients.
// These helpers only arrange an explicit test state; they never move a live AI.
export const lifePosition = (world, key) => structuredClone(world.getRules().life[key].service_center);
export const marketPosition = world => structuredClone(world.getRules().life.market.place.service_center);
export const plazaPlacePosition = (world, id) => {
  const place = world.getRules().places.find(row => row.id === id);
  return { x: place.x, y: place.y };
};
export const plazaPortalPosition = world => structuredClone(world.getRules().scenes.find(row => row.id === 'plaza').portal.position);
export const resourcePosition = (world, id) => structuredClone(world.getRules().resources.nodes.find(row => row.id === id).interaction_position);

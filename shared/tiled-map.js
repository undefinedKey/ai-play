// Pure data compiler shared by Node, the browser and map validation tooling.
// Tiled tile objects use bottom-left alignment; sprite feet are at (64,120).
const ids = ['plaza', 'adventure'];
const fail = message => { throw new Error(`Invalid Tiled world map: ${message}`); };
function need(value, message) { if (!value) fail(message); }
function properties(items = []) {
  need(Array.isArray(items), 'properties must be an array');
  const result = Object.create(null);
  for (const item of items) {
    need(typeof item.name === 'string' && !Object.hasOwn(result, item.name), 'duplicate property');
    result[item.name] = item.value;
  }
  return result;
}
export function compileTiledScene(source) {
  need(source?.type === 'map' && source.orientation === 'orthogonal' && source.infinite === false, 'expected finite orthogonal map');
  need(source.width === 48 && source.height === 32 && source.tilewidth === 32 && source.tileheight === 32, 'current world requires 48×32 cells of 32 pixels');
  const inBounds = p => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < source.width && p.y >= 0 && p.y < source.height;
  const meta = properties(source.properties);
  need(ids.includes(meta.scene_id) && ids.includes(meta.destination_scene) && meta.scene_id !== meta.destination_scene, 'invalid scene link');
  need(typeof meta.scene_name === 'string' && meta.scene_name.length > 0 && meta.scene_name.length <= 40, 'invalid scene name');
  need(Array.isArray(source.layers) && source.layers.length === 2, 'expected ground and prop layers');
  const ground = source.layers.find(l => l.type === 'imagelayer'), layer = source.layers.find(l => l.type === 'objectgroup');
  need(ground?.image === '../../public/pixel-world/ground_ink.png' && ground.imagewidth===source.width*32 && ground.imageheight===source.height*32, 'ground image must match world dimensions');
  need(layer && Array.isArray(layer.objects) && layer.objects.length <= 512, 'missing prop objects');
  for (const item of [ground, layer]) need(!item.x && !item.y && !item.offsetx && !item.offsety && item.visible !== false && item.opacity === 1, 'layer offsets/visibility must not alter geometry');
  need(Array.isArray(source.tilesets) && source.tilesets.length === 1, 'one embedded sprite collection required');
  const tileset = source.tilesets[0];
  need(tileset.firstgid === 1 && tileset.objectalignment === 'bottomleft' && Array.isArray(tileset.tiles), 'unsupported tileset alignment');
  const tiles = new Map();
  for (const tile of tileset.tiles) {
    need(Number.isSafeInteger(tile.id) && tile.id >= 0 && !tiles.has(tile.id), 'duplicate tile id');
    const kind = tile.class || tile.type;
    need(/^[a-z][a-z0-9_]*$/.test(kind) && tile.image === `../../public/pixel-world/${kind}.png`, 'invalid sprite reference');
    need(tile.imagewidth === 128 && tile.imageheight === 128, 'world sprite must retain original 128×128 anchor');
    tiles.set(tile.id, {...tile, kind});
  }
  const names = new Set(), objectIds = new Set();
  const props = layer.objects.map(object => {
    need(Number.isSafeInteger(object.id) && !objectIds.has(object.id), 'duplicate object id'); objectIds.add(object.id);
    need(/^[a-z][a-z0-9_]*$/.test(object.name) && !names.has(object.name), 'duplicate or invalid prop name'); names.add(object.name);
    need(object.rotation === 0 && object.visible !== false && Number.isFinite(object.x) && Number.isFinite(object.y), 'unsupported rotated/hidden prop');
    let position, kind;
    if (object.point === true) {
      need((object.class || object.type) === 'pond' && !object.gid && object.width === 0 && object.height === 0, 'only the painted pond uses a point');
      kind = 'pond'; position = { x: object.x / 32 - .5, y: object.y / 32 - .5 };
    } else {
      const tile = tiles.get(object.gid - 1);
      need(tile && (object.class || object.type) === tile.kind && object.width === 128 && object.height === 128, 'unrecognised, flipped or resized sprite');
      kind = tile.kind; position = { x: (object.x + 64) / 32 - .5, y: (object.y - 8) / 32 - .5 };
    }
    need(inBounds(position), 'prop foot must snap to an in-bounds cell centre');
    let offsets;
    try { offsets = JSON.parse(properties(object.properties).footprint); } catch { fail('footprint must be JSON cell offsets'); }
    need(Array.isArray(offsets) && offsets.length <= 64, 'invalid footprint length');
    const seen = new Set();
    const footprint = offsets.map(offset => {
      need(Array.isArray(offset) && offset.length === 2 && offset.every(Number.isSafeInteger), 'invalid footprint offset');
      const p = { x: position.x + offset[0], y: position.y + offset[1] }, key = `${p.x},${p.y}`;
      need(inBounds(p) && !seen.has(key), 'duplicate or out-of-bounds footprint'); seen.add(key); return p;
    });
    need(object.name === 'portal' ? kind === `portal_${meta.scene_id}` && footprint.length === 0 : footprint.length > 0, 'only the portal may have an empty footprint');
    return { id: object.name, kind, position, footprint };
  });
  const portal = props.find(p => p.id === 'portal'); need(portal, 'missing portal');
  const blocked = [...new Map(props.flatMap(p => p.footprint).map(p => [`${p.x},${p.y}`, p])).values()];
  const blockedKeys = new Set(blocked.map(p => `${p.x},${p.y}`));
  need(!blockedKeys.has(`${portal.position.x},${portal.position.y}`), 'blocked portal');
  const visited = new Set(), pending = [portal.position];
  while (pending.length) {
    const p = pending.pop(), key = `${p.x},${p.y}`;
    if (!inBounds(p) || blockedKeys.has(key) || visited.has(key)) continue;
    visited.add(key);
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) pending.push({x:p.x+dx,y:p.y+dy});
  }
  need(visited.size === source.width * source.height - blocked.length, 'isolated walkable cells');
  return { id: meta.scene_id, name: meta.scene_name, map: {width:source.width,height:source.height}, portal: {position:portal.position,to_scene_id:meta.destination_scene}, blocked, props };
}
export function compileWorldMaps(sources) {
  need(Array.isArray(sources) && sources.length === 2, 'two scenes required');
  const scenes = sources.map(compileTiledScene);
  need(ids.every(id => scenes.filter(s => s.id === id).length === 1), 'scene IDs must be unique');
  for (const scene of scenes) {
    const target = scenes.find(s => s.id === scene.portal.to_scene_id);
    need(target?.portal.to_scene_id === scene.id, 'portals must be reciprocal');
    scene.portal.to_position = {...target.portal.position};
  }
  return ids.map(id => scenes.find(s => s.id === id));
}

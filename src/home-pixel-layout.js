// Room-space pixels describe presentation only. The saved tile coordinates,
// rotated collision footprint and legal interaction point stay authoritative.
export const HOME_ROOM = Object.freeze({ width: 640, height: 540, floorX: 70, floorY: 135, tileWidth: 50, tileHeight: 42 });

const footprints = { chair: [1, 1], table: [2, 1], rug: [2, 2], display_shelf: [2, 1], bed: [2, 2], bookshelf: [2, 1] };
const defaults = {
  chair: { width: 50, height: 64, anchor: { x: 25, y: 64 }, seat: { x: 25, y: 40 } },
  table: { width: 100, height: 72, anchor: { x: 50, y: 72 } },
  rug: { width: 100, height: 84, anchor: { x: 50, y: 84 } },
  display_shelf: { width: 100, height: 100, anchor: { x: 50, y: 100 } },
  bed: { width: 100, height: 112, anchor: { x: 50, y: 112 }, seat: { x: 60, y: 63 } },
  bookshelf: { width: 100, height: 100, anchor: { x: 50, y: 100 } },
};

export function homeFurnitureRotation(item) {
  const rotation = ((Number(item?.rotation) || 0) % 360 + 360) % 360;
  return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
}

export function homeFurnitureFootprint(item, rules) {
  const definition = rules?.furniture_catalog?.[item.kind], fallback = footprints[item.kind] || [1, 1];
  const size = [definition?.width || fallback[0], definition?.height || fallback[1]];
  return [90, 270].includes(homeFurnitureRotation(item)) ? size.reverse() : size;
}

export function homeRoomFoot(position) {
  return { x: HOME_ROOM.floorX + (position.x + .5) * HOME_ROOM.tileWidth, y: HOME_ROOM.floorY + (position.y + .7) * HOME_ROOM.tileHeight };
}

export function homeRoomDepth(point) {
  return Math.round(point.y * 10);
}

// Art metadata is independent of inventory dimensions: images retain one
// aspect ratio and are anchored at the front centre of their actual footprint.
export function homeFurnitureLayout(item, rules, artSpec) {
  const rotation = homeFurnitureRotation(item), footprint = homeFurnitureFootprint(item, rules);
  const spec = artSpec?.variants?.[String(rotation)] || artSpec || defaults[item.kind] || defaults.chair;
  const width = spec.width, height = spec.height;
  const anchor = spec.anchor || { x: width / 2, y: height };
  const foot = { x: HOME_ROOM.floorX + (item.x + footprint[0] / 2) * HOME_ROOM.tileWidth, y: HOME_ROOM.floorY + (item.y + footprint[1]) * HOME_ROOM.tileHeight };
  const x = foot.x - anchor.x, y = foot.y - anchor.y;
  const depth = item.kind === 'rug' ? 1 : homeRoomDepth(foot);
  return { x, y, width, height, foot, footprint, rotation, depth, foregroundDepth: depth + 2,
    seat: spec.seat ? { x: x + spec.seat.x, y: y + spec.seat.y } : null,
    facing: spec.facing || (item.kind === 'bed' ? ({ 0: 'east', 90: 'south', 180: 'west', 270: 'north' })[rotation] : ({ 0: 'south', 90: 'west', 180: 'north', 270: 'east' })[rotation]),
    style: { left: `${x / HOME_ROOM.width * 100}%`, top: `${y / HOME_ROOM.height * 100}%`, width: `${width / HOME_ROOM.width * 100}%`, height: `${height / HOME_ROOM.height * 100}%`, zIndex: depth },
  };
}

export function homeActorDepth(position, seatLayout) {
  return seatLayout ? seatLayout.depth + 1 : homeRoomDepth(homeRoomFoot(position)) + 1;
}

const dimension = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;

export function mapDimensions(map) {
  return { width: dimension(map?.width, 24), height: dimension(map?.height, 16) };
}

export function projectMapPoint(position, map) {
  const { width, height } = mapDimensions(map);
  const coordinate = (value, size) => Math.max(0, Math.min(size - 1, Number.isFinite(value) ? value : 0));
  return {
    left: `${(coordinate(position?.x, width) + .5) / width * 100}%`,
    top: `${(coordinate(position?.y, height) + .5) / height * 100}%`,
  };
}

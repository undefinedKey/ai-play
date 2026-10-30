import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDimensions, projectMapPoint } from '../src/map-projection.js';

test('map projection uses server dimensions and cell centers', () => {
  assert.deepEqual(mapDimensions({ width: 12, height: 8 }), { width: 12, height: 8 });
  assert.deepEqual(projectMapPoint({ x: 5.5, y: 3.5 }, { width: 12, height: 8 }), { left: '50%', top: '50%' });
  assert.deepEqual(projectMapPoint({ x: 0, y: 0 }, { width: 1, height: 1 }), { left: '50%', top: '50%' });
  assert.notEqual(projectMapPoint({ x: 10, y: 5 }, { width: 12, height: 8 }).left, projectMapPoint({ x: 10, y: 5 }, { width: 24, height: 16 }).left);
});

test('out-of-range and malformed coordinates never produce invalid CSS or leave the map', () => {
  for (const x of [-100, 100000, Infinity, -Infinity, NaN, undefined, null, 'bad']) {
    for (const y of [-100, 100000, Infinity, -Infinity, NaN, undefined, null, 'bad']) {
      const point = projectMapPoint({ x, y }, { width: 24, height: 16 });
      for (const value of Object.values(point)) {
        assert.equal(Number.isFinite(parseFloat(value)), true);
        assert.ok(parseFloat(value) > 0 && parseFloat(value) < 100);
      }
    }
  }
  assert.deepEqual(projectMapPoint({ x: -20, y: 300 }, { width: 24, height: 16 }), projectMapPoint({ x: 0, y: 15 }, { width: 24, height: 16 }));
});

test('missing or invalid map sizes use compatible finite defaults', () => {
  for (const map of [undefined, null, {}, { width: 0, height: -2 }, { width: NaN, height: Infinity }, { width: 3.5, height: '16' }]) {
    assert.deepEqual(mapDimensions(map), { width: 24, height: 16 });
    const point = projectMapPoint(null, map);
    assert.equal(Number.isFinite(parseFloat(point.left)), true);
    assert.equal(Number.isFinite(parseFloat(point.top)), true);
  }
});

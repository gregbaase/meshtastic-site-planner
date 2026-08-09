import { describe, it, expect } from 'vitest';

import { computeBridge } from '../src/bridge';
import type { CoverageResult } from '../src/engine/CoverageEngine';

/** Minimal CoverageResult around the equator (cos(lat) ~ 1), matching the
 * helper in coverageStats.test.ts. Cells are ~1.24 km² at pixelDegrees 0.01. */
function grid(dbm: number[], width: number, height: number, pixelDegrees = 0.01): CoverageResult {
  const halfH = (height * pixelDegrees) / 2;
  const halfW = (width * pixelDegrees) / 2;
  return {
    dbm: Float32Array.from(dbm),
    width,
    height,
    bounds: { north: halfH, south: -halfH, west: -halfW, east: halfW },
    pixelDegrees,
    stats: { radials: 0, pages: 0, pagesWithData: 0, itmWarnings: [], elapsedMs: 0, workers: 1 },
  };
}

const THRESHOLD = -130;
// Transmitters sit at the grid centre for both sites (both grids are origin-centered).
const TX = { txLatA: 0, txLonA: 0, txLatB: 0, txLonB: 0 };

describe('computeBridge', () => {
  it('full overlap of two identical strong sites', () => {
    const a = grid([-100, -100, -100, -100], 2, 2);
    const r = computeBridge({ resultA: a, resultB: grid([-100, -100, -100, -100], 2, 2), thresholdA: THRESHOLD, thresholdB: THRESHOLD, ...TX });
    expect(r.hasOverlap).toBe(true);
    expect(r.best).not.toBeNull();
    expect(r.best!.score).toBeCloseTo(-100, 6);
    // All 4 cells overlap → ~4.96 km².
    expect(r.areaKm2).toBeCloseTo(4.96, 0);
    expect(Array.from(r.overlap.dbm)).toEqual([-100, -100, -100, -100]);
  });

  it('no overlap when the sites do not reach each other (B has no coverage)', () => {
    const a = grid([-90, -90, -90, -90], 2, 2);
    const b = grid([NaN, NaN, NaN, NaN], 2, 2);
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: THRESHOLD, thresholdB: THRESHOLD, ...TX });
    expect(r.hasOverlap).toBe(false);
    expect(r.best).toBeNull();
    expect(r.bestMarginDb).toBeNull();
    expect(r.areaKm2).toBe(0);
    expect(Array.from(r.overlap.dbm).every(Number.isNaN)).toBe(true);
  });

  it('overlap is the coverage intersection, scored by min(A,B)', () => {
    // A strong on the LEFT pair, weak (below threshold) on the RIGHT pair.
    const a = grid([-80, -80, -140, -140], 2, 2);
    // B strong on the TOP pair, weak on the BOTTOM pair.
    const b = grid([-80, -140, -80, -140], 2, 2);
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: THRESHOLD, thresholdB: THRESHOLD, ...TX });
    // Only cell (top-left) hears both; that's the bridgeable region.
    expect(r.hasOverlap).toBe(true);
    expect(r.areaKm2).toBeCloseTo(1.24, 0);
    expect(r.best!.lat).toBeCloseTo(0.005, 6);
    expect(r.best!.lon).toBeCloseTo(-0.005, 6);
    expect(r.best!.score).toBeCloseTo(-80, 6);
    expect(r.bestMarginDb).toBeCloseTo(-80 - THRESHOLD, 6); // 50 dB of margin
    // Overlap grid: only top-left populated.
    expect(r.overlap.dbm[0]).toBeCloseTo(-80, 6);
    expect(Number.isNaN(r.overlap.dbm[1])).toBe(true);
    expect(Number.isNaN(r.overlap.dbm[2])).toBe(true);
    expect(Number.isNaN(r.overlap.dbm[3])).toBe(true);
  });

  it('best placement maximizes min(A,B)', () => {
    // A strong everywhere. B strongest at top-left, weaker elsewhere.
    const a = grid([-110, -110, -110, -110], 2, 2);
    const b = grid([-60, -120, -120, -120], 2, 2);
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: THRESHOLD, thresholdB: THRESHOLD, ...TX });
    // All 4 cells overlap; min() is -110 at top-left (A is the weak link there),
    // and -120 elsewhere → best is the top-left cell.
    expect(r.hasOverlap).toBe(true);
    expect(r.best!.score).toBeCloseTo(-110, 6);
    expect(r.best!.lat).toBeCloseTo(0.005, 6);
    expect(r.best!.lon).toBeCloseTo(-0.005, 6);
  });

  it('resamples a non-aligned (finer) second grid onto the first', () => {
    // A coarse 2x2 (0.01°/cell); B fine 4x4 (0.005°/cell) over the SAME bounds.
    const a = grid([-80, -80, -80, -80], 2, 2, 0.01);
    const b = grid(
      [-80, -80, -80, -80, -80, -80, -80, -80, -80, -80, -80, -80, -80, -80, -80, -80],
      4, 4, 0.005
    );
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: THRESHOLD, thresholdB: THRESHOLD, ...TX });
    expect(r.hasOverlap).toBe(true);
    expect(r.areaKm2).toBeCloseTo(4.96, 0); // all 4 coarse cells overlap
    expect(Array.from(r.overlap.dbm)).toEqual([-80, -80, -80, -80]);
  });

  it('reports a direct link (no bridge needed) when each site hears the other', () => {
    // Both transmitters sit in the centre where both grids are strong (-80 ≥ -130).
    const a = grid([-80, -80, -80, -80], 2, 2);
    const b = grid([-80, -80, -80, -80], 2, 2);
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: THRESHOLD, thresholdB: THRESHOLD, ...TX });
    expect(r.directLink).toBe(true);
    expect(r.directMarginDb).toBeCloseTo(-80 - THRESHOLD, 6); // 50 dB of margin
  });

  it('does NOT report a direct link when the sites cannot hear each other', () => {
    // Both transmitters in the centre, but each site is weak (-140 < -130) there.
    const weak = grid([-140, -140, -140, -140], 2, 2);
    const r = computeBridge({ resultA: weak, resultB: weak, thresholdA: THRESHOLD, thresholdB: THRESHOLD, txLatA: 0, txLonA: 0, txLatB: 0, txLonB: 0 });
    expect(r.directLink).toBe(false);
    expect(r.directMarginDb).toBeCloseTo(-140 - THRESHOLD, 6); // negative margin
  });
});

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

  it('resamples non-uniform B columns to the NEAREST pixel center', () => {
    // A coarse 2x2 (0.01°/cell over ±0.01°); B fine 5x5 (0.004°/cell) over the
    // SAME span, with a DISTINCT dBm per B column so the sampled column is
    // observable: col0=-80, col1=-90, col2=-100, col3=-110, col4=-120.
    const a = grid([-80, -80, -80, -80], 2, 2, 0.01);
    const b = grid(
      [-80, -90, -100, -110, -120,
       -80, -90, -100, -110, -120,
       -80, -90, -100, -110, -120,
       -80, -90, -100, -110, -120,
       -80, -90, -100, -110, -120],
      5, 5, 0.004
    );
    // Both rasters span ±0.01°. A cell centers sit at lon = -0.005 (col0) and
    // +0.005 (col1). B column centers are at -0.008, -0.004, 0, +0.004, +0.008,
    // so each A center maps unambiguously (no tie):
    //  - A col0 (-0.005) → nearest B col1 (-90), margin 0.001 vs col0 (-80)
    //  - A col1 (+0.005) → nearest B col3 (-110), margin 0.001 vs col4 (-120)
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: THRESHOLD, thresholdB: THRESHOLD, ...TX });
    expect(r.hasOverlap).toBe(true);
    // Overlap = min(A,B): A(-80) with B col1 → -90; A(-80) with B col3 → -110.
    expect(Array.from(r.overlap.dbm)).toEqual([-90, -110, -90, -110]);
    expect(r.best!.score).toBeCloseTo(-90, 6); // stronger overlap on the left pair
  });

  it('skips B columns outside the raster longitude range (no phantom wrap)', () => {
    // A spans lon [-0.01, +0.01]; B is FAR east, spanning [10, 10.008] with a
    // strong center column. A's cells are genuinely outside B's longitude
    // extent, so they must NOT be wrapped onto a bogus B column.
    const a = grid([-70, -70, -70, -70], 2, 2, 0.01); // lat/lon ≈ 0
    const b: CoverageResult = {
      dbm: Float32Array.from([-80, -80, -80, -80]),
      width: 2,
      height: 2,
      bounds: { north: 0.01, south: -0.01, west: 10, east: 10.01 },
      pixelDegrees: 0.005,
      stats: { radials: 0, pages: 0, pagesWithData: 0, itmWarnings: [], elapsedMs: 0, workers: 1 },
    };
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: THRESHOLD, thresholdB: THRESHOLD, txLatA: 0, txLonA: 0, txLatB: 0, txLonB: 0 });
    // Every A cell lies ~10° from B, outside its longitude span → none overlap.
    expect(r.hasOverlap).toBe(false);
    expect(Array.from(r.overlap.dbm).every(Number.isNaN)).toBe(true);
    expect(r.best).toBeNull();
  });

  it('reports a direct link (no bridge needed) when each site hears the other', () => {
    // Distinct TX coordinates + non-uniform rasters so each direction is checked
    // independently. A and B are each 2x2 (row-major, bounds ±0.01°); cell (TR,
    // index 1) sits at lat 0.005, lon 0.005 and cell (TL, index 0) at 0.005, -0.005.
    const a = grid([-140, -90, -140, -140], 2, 2); // A strong only at TR (idx 1)
    const b = grid([-140, -95, -140, -140], 2, 2); // B strong only at TR (idx 1)
    // TX-B sits on A's TR cell  → aAtB = A's signal at B = -90.
    // TX-A sits on B's TR cell  → bAtA = B's signal at A = -95.
    const r = computeBridge({
      resultA: a, resultB: b,
      thresholdA: THRESHOLD, thresholdB: THRESHOLD,
      txLatA: 0.005, txLonA: 0.005, txLatB: 0.005, txLonB: 0.005,
    });
    expect(r.directLink).toBe(true); // -90 ≥ -130 AND -95 ≥ -130
    expect(r.directMarginDb).toBeCloseTo(Math.min(-90 - THRESHOLD, -95 - THRESHOLD), 6); // min(40, 35) = 35
  });

  it('does NOT report a direct link when a site is below threshold at the other', () => {
    // TX-B sits on a WEAK A cell (idx 1 = -140 < -130); TX-A on a strong B cell.
    const a = grid([-140, -140, -140, -140], 2, 2);
    const b = grid([-140, -95, -140, -140], 2, 2);
    const r = computeBridge({
      resultA: a, resultB: b,
      thresholdA: THRESHOLD, thresholdB: THRESHOLD,
      txLatA: 0.005, txLonA: 0.005, txLatB: 0.005, txLonB: 0.005,
    });
    expect(r.directLink).toBe(false); // aAtB = -140 < -130
    expect(r.directMarginDb).toBeCloseTo(Math.min(-140 - THRESHOLD, -95 - THRESHOLD), 6); // min(-10, 35) = -10
  });

  it('direct-link margin uses each endpoint threshold when they differ', () => {
    const a = grid([-140, -90, -140, -140], 2, 2); // A hears B at -90
    const b = grid([-140, -95, -140, -140], 2, 2); // B hears A at -95
    const r = computeBridge({
      resultA: a, resultB: b,
      thresholdA: -120, thresholdB: -100, // distinct per endpoint
      txLatA: 0.005, txLonA: 0.005, txLatB: 0.005, txLonB: 0.005,
    });
    // aAtB = -90 (vs -120) → margin 30; bAtA = -95 (vs -100) → margin 5.
    expect(r.directLink).toBe(true); // -90 ≥ -120 AND -95 ≥ -100
    expect(r.directMarginDb).toBeCloseTo(Math.min(-90 - -120, -95 - -100), 6); // min(30, 5) = 5
  });

  it('best margin is the SMALLER per-link margin when thresholds differ', () => {
    // Best cell: A=-100 (margin vs ta=-120 → 20), B=-95 (margin vs tb=-100 → 5).
    // min(A,B) = -100, but the weaker per-link margin is 5, NOT 0 (= bestScore - max(t)).
    const a = grid([-100, -100, -100, -100], 2, 2);
    const b = grid([-95, -95, -95, -95], 2, 2);
    const r = computeBridge({ resultA: a, resultB: b, thresholdA: -120, thresholdB: -100, ...TX });
    expect(r.hasOverlap).toBe(true);
    expect(r.bestMarginDb).toBeCloseTo(5, 6); // min(20, 5) = 5
    expect(r.best!.score).toBeCloseTo(-100, 6); // min(A,B) unchanged
  });
});

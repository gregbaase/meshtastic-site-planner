/* Bridge-node placement analysis.
 *
 * Given ONE simulated site (A) and a second point (B) — placed on the map via
 * the point-to-point link tool and given the site's own radio values — find the
 * regions where a single *additional* node could act as a relay and bridge them:
 * i.e. where a node can be reached by BOTH transmitters.
 *
 * The store already holds A's received-power dBm grid. B's grid is computed on
 * demand with the same engine (same site + receiver values, moved to B), so the
 * two coverage fields are directly comparable. Because links are modeled as
 * symmetric (the same ITM path is used for the reverse direction — see
 * engine/link.ts), a cell where `A.dbm >= thresholdA` means a relay there can
 * *hear A*, and a cell where `B.dbm >= thresholdB` means it can *hear B*. A cell
 * satisfying both is therefore exactly a place a single node can bridge the two
 * otherwise-disconnected networks.
 *
 *  - The bridgeable region is the coverage OVERLAP of A and B.
 *  - The "best" placement is the cell in that region maximizing min(A,B) dBm —
 *    the node stays as deep inside both coverage edges as possible.
 *
 * This module is intentionally pure (CoverageResult in → overlap grid + stats
 * out) and free of any MapLibre/DOM dependency, so the same code can back a
 * future server/edge API, mirrors coverageStats.ts and coverageContours.ts, and
 * is trivially unit-testable. Rendering the returned grid reuses the existing
 * heatmap (src/map/overlay.ts) and contour (src/map/contours.ts) pipelines.
 */

import type { CoverageResult } from './engine/CoverageEngine';

export interface BridgeInput {
  /** dBm grid for site A (already radius-cropped). */
  resultA: CoverageResult;
  /** dBm grid for site B (already radius-cropped). */
  resultB: CoverageResult;
  /** Receiver sensitivity of A's network, dBm. Cells below this can't hear A. */
  thresholdA: number;
  /** Receiver sensitivity of B's network, dBm. Cells below this can't hear B. */
  thresholdB: number;
  /** Transmitter position of site A (used for direct A<->B link detection). */
  txLatA: number;
  txLonA: number;
  /** Transmitter position of site B. */
  txLatB: number;
  txLonB: number;
}

export interface BridgeCell {
  lat: number;
  lon: number;
  /** min(A.dbm, B.dbm) at this cell, dBm (the overlap score). */
  score: number;
}

export interface BridgeResult {
  /** Overlap field shaped like a CoverageResult so it drops straight into the
   * existing heatmap/contour renderers. Score = min(A,B) where both A and B
   * reach their thresholds, else NaN (transparent / outside all bands). */
  overlap: CoverageResult;
  /** Best single placement: cell maximizing min(A,B). null if no overlap. */
  best: BridgeCell | null;
  /** Signal margin at the best point = the weaker of the two per-link margins
   * (min(A.dbm - thresholdA, B.dbm - thresholdB)), dB (>0 means the bridge is
   * comfortably inside both coverage edges). */
  bestMarginDb: number | null;
  /** Ground area of the bridgeable region, km². */
  areaKm2: number;
  /** True when at least one cell bridges A and B. */
  hasOverlap: boolean;
  /** True when A and B already reach each other directly (a node at B hears A
   * and a node at A hears B), so no additional relay is needed at all. */
  directLink: boolean;
  /** Signal margin (dB) of the direct A<->B link = min(signal-of-A-at-B minus
   * A's threshold, signal-of-B-at-A minus B's threshold). >0 = comfortable. */
  directMarginDb: number | null;
}

const M_PER_DEG_LAT = 111320;

/** True if two rasters share grid geometry (same dims, bounds, resolution) so
 * they can be combined cell-for-cell with no resampling. */
function aligned(a: CoverageResult, b: CoverageResult): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.bounds.north - b.bounds.north) < 1e-9 &&
    Math.abs(a.bounds.south - b.bounds.south) < 1e-9 &&
    Math.abs(a.bounds.east - b.bounds.east) < 1e-9 &&
    Math.abs(a.bounds.west - b.bounds.west) < 1e-9 &&
    Math.abs(a.pixelDegrees - b.pixelDegrees) < 1e-12
  );
}

/**
 * Sample B's dBm at an arbitrary (lat, lon) using nearest-neighbor. Antimeridian
 * (period-360) crossing is applied ONLY when B's raster actually crosses the
 * ±180° meridian (region bounds reported beyond ±180, e.g. west=175, east=182.5);
 * otherwise a longitude outside [west, east] is genuinely outside B's grid and
 * returns NaN instead of silently wrapping onto an unrelated column. Only used
 * when A and B are NOT aligned (the common case is aligned).
 */
function sampleNearest(result: CoverageResult, lat: number, lon: number): number {
  const { bounds, width, height, pixelDegrees } = result;
  if (lat > bounds.north || lat < bounds.south) return NaN;
  const span = bounds.east - bounds.west;
  if (!(span > 0)) return NaN;
  // Rasters whose reported bounds lie either side of ±180° cross the
  // antimeridian (SPLAT reports signed degrees, so the region spans e.g.
  // 175…182.5 near lon 180); only those wrap by 360°.
  const crossesAntimeridian = bounds.west < -180 || bounds.east > 180;
  let frac = (lon - bounds.west) / span;
  if (crossesAntimeridian) {
    frac = ((frac % 1) + 1) % 1; // wrap into [0,1)
  } else if (frac < 0 || frac > 1) {
    return NaN; // outside [west, east] — genuinely not on this raster
  }
  // Nearest pixel center, clamped to the valid column range.
  const col = Math.min(width - 1, Math.max(0, Math.round(frac * width - 0.5)));
  const row = Math.max(0, Math.min(height - 1, Math.round((bounds.north - lat) / pixelDegrees - 0.5)));
  return result.dbm[row * width + col];
}

/**
 * Compute the bridgeable region between two sites and the best relay placement.
 * Pure and DOM-free; throws only if given zero-dimension rasters.
 */
export function computeBridge(input: BridgeInput): BridgeResult {
  const A = input.resultA;
  const B = input.resultB;
  const ta = input.thresholdA;
  const tb = input.thresholdB;
  if (A.width <= 0 || A.height <= 0 || B.width <= 0 || B.height <= 0) {
    throw new Error('coverage rasters must be non-empty');
  }

  const same = aligned(A, B);
  const dbm = new Float32Array(A.width * A.height);
  let bestScore = -Infinity;
  let bestRow = -1;
  let bestCol = -1;
  let overlapCells = 0;
  let areaM2 = 0;

  for (let row = 0; row < A.height; row++) {
    const lat = A.bounds.north - (row + 0.5) * A.pixelDegrees;
    const cellAreaM2 =
      A.pixelDegrees * M_PER_DEG_LAT * A.pixelDegrees * M_PER_DEG_LAT *
      Math.max(0, Math.cos((lat * Math.PI) / 180));
    for (let col = 0; col < A.width; col++) {
      const i = row * A.width + col;
      const a = A.dbm[i];
      const b = same
        ? B.dbm?.[i] ?? NaN
        : sampleNearest(B, lat, A.bounds.west + (col + 0.5) * A.pixelDegrees);
      if (a >= ta && b >= tb) {
        const score = a < b ? a : b; // min(A,B): upstream constraint is the weak link
        dbm[i] = score;
        overlapCells++;
        areaM2 += cellAreaM2;
        if (score > bestScore) {
          bestScore = score;
          bestRow = row;
          bestCol = col;
        }
      } else {
        dbm[i] = NaN;
      }
    }
  }

  let best: BridgeCell | null = null;
  let bestMarginDb: number | null = null;
  if (bestRow >= 0) {
    const lat = A.bounds.north - (bestRow + 0.5) * A.pixelDegrees;
    const lon = A.bounds.west + (bestCol + 0.5) * A.pixelDegrees;
    best = { lat, lon, score: bestScore };
    // Weaker of the two per-link margins at the best cell (each link's own
    // threshold), NOT bestScore - max(thresholds) — that pairing is wrong
    // whenever the two thresholds differ.
    const aBest = A.dbm[bestRow * A.width + bestCol];
    const bBest = same
      ? B.dbm?.[bestRow * A.width + bestCol] ?? NaN
      : sampleNearest(B, lat, lon);
    bestMarginDb = Math.min(aBest - ta, bBest - tb);
  }

  const overlap: CoverageResult = {
    dbm,
    width: A.width,
    height: A.height,
    bounds: A.bounds,
    pixelDegrees: A.pixelDegrees,
    // Copied for shape only; the overlap is derived, not a fresh engine run.
    stats: { ...A.stats },
  };

  // Direct-link check: if each transmitter is inside the OTHER's coverage, the
  // two sites already hear each other and no relay is needed.
  const aAtB = sampleNearest(A, input.txLatB, input.txLonB); // A's signal where B is
  const bAtA = sampleNearest(B, input.txLatA, input.txLonA); // B's signal where A is
  const bothKnown = !Number.isNaN(aAtB) && !Number.isNaN(bAtA);
  const directLink = bothKnown && aAtB >= ta && bAtA >= tb;
  const directMarginDb = bothKnown ? Math.min(aAtB - ta, bAtA - tb) : null;

  return {
    overlap,
    best,
    bestMarginDb,
    areaKm2: areaM2 / 1e6,
    hasOverlap: overlapCells > 0,
    directLink,
    directMarginDb,
  };
}

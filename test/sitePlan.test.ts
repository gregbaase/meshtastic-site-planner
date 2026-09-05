import { describe, it, expect } from 'vitest';

import { exportSitePlan, serializeSitePlan, parseSitePlan, isSupportedSitePlan, rehydrateSites, SITE_PLAN_FORMAT } from '../src/sitePlan';
import type { Site } from '../src/types';

/** Minimal factory site for tests (params only matter; result/stats are stubs). */
function site(name: string, lat = 51.05, lon = -114.07): Site {
  return {
    id: `id-${name}`,
    visible: true,
    params: {
      transmitter: { name, tx_lat: lat, tx_lon: lon, tx_power: 0.5, tx_freq: 915, tx_height: 10, tx_gain: 5 },
      receiver: { rx_sensitivity: -130, rx_height: 1, rx_gain: 2, rx_loss: 2 },
      environment: { radio_climate: 'continental_temperate', polarization: 'vertical', clutter_height: 1, ground_dielectric: 15, ground_conductivity: 0.005, atmosphere_bending: 301 },
      simulation: { situation_fraction: 95, time_fraction: 95, simulation_extent: 30, high_resolution: false },
      display: { color_scale: 'plasma', min_dbm: -130, max_dbm: -80, overlay_transparency: 50 },
    },
    result: undefined as never, // not serialized; only params are used
    stats: { thresholdDbm: -130, areaKm2: 0, maxRangeKm: 0, coveredFraction: 0 },
  };
}

describe('site-plan export/import', () => {
  it('round-trips params with no coverage payload', () => {
    const plan = exportSitePlan([site('A'), site('B')], { projectName: 'Study' });
    expect(plan.format).toBe(SITE_PLAN_FORMAT);
    expect(plan.version).toBe(1);
    expect(plan.projectName).toBe('Study');
    expect(plan.sites).toHaveLength(2);
    expect(plan.sites[0].name).toBe('A');
    expect(plan.sites[0].params.transmitter.tx_freq).toBe(915);
    // Critically: coverage grids must NOT be persisted (they're large & cheap to recompute).
    expect('result' in plan.sites[0]).toBe(false);
    expect('result' in plan.sites[0].params).toBe(false);
  });

  it('serialize → parse is an identity', () => {
    const plan = exportSitePlan([site('A'), site('B')]);
    const parsed = parseSitePlan(serializeSitePlan(plan));
    expect(parsed.version).toBe(1);
    expect(parsed.sites.map((s) => s.name)).toEqual(['A', 'B']);
    expect(parsed.sites[0].params.transmitter.tx_lat).toBeCloseTo(51.05, 6);
    expect(parsed.sites[1].params.transmitter.tx_lon).toBeCloseTo(-114.07, 6);
    expect(rehydrateSites(parsed)).toHaveLength(2);
  });

  it('rejects malformed JSON with a clear error', () => {
    expect(() => parseSitePlan('not json')).toThrow('Not valid JSON');
  });

  it('rejects wrong format or a future (higher) version', () => {
    expect(isSupportedSitePlan({ format: 'something-else', version: 1, sites: [] })).toBe(false);
    expect(isSupportedSitePlan({ format: SITE_PLAN_FORMAT, version: 999, sites: [] })).toBe(false);
    expect(() => parseSitePlan(JSON.stringify({ format: SITE_PLAN_FORMAT, version: 2, sites: [] })))
      .toThrow(/unsupported/);
  });

  it('drops malformed site entries but keeps valid ones on import', () => {
    const plan = exportSitePlan([site('A'), site('B')]);
    (plan.sites as unknown[]).push({ name: 'broken' }); // no params
    const parsed = parseSitePlan(serializeSitePlan(plan));
    expect(parsed.sites.map((s) => s.name)).toEqual(['A', 'B']);
  });
});

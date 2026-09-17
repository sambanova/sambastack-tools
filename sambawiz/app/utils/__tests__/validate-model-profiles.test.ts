import type { ModelProfilesCache } from '../../types/bundle';
import {
  validateModelProfilesCache,
  diffModelProfilesCaches,
  describeDrift,
} from '../validate-model-profiles';

function entry(batchingConfig: ModelProfilesCache[string]['batchingConfig']): ModelProfilesCache[string] {
  return { model_arch: 'arch', features: [], batchingConfig, pefs: [] };
}

describe('validateModelProfilesCache', () => {
  it('accepts a profile that offers batch sizes at every tier', () => {
    const cache: ModelProfilesCache = {
      good: entry({ '8k': { batch_sizes: [2, 4] }, '32k': { batch_sizes: [2] } }),
    };
    expect(validateModelProfilesCache(cache)).toEqual([]);
  });

  it('accepts a profile with no batching config, which the operator fills in', () => {
    expect(validateModelProfilesCache({ bare: entry({}) })).toEqual([]);
  });

  it('accepts a wildcard tier', () => {
    const cache: ModelProfilesCache = { star: entry({ '8k': { batch_sizes: '*' } }) };
    expect(validateModelProfilesCache(cache)).toEqual([]);
  });

  it('reports a profile whose every tier offers no batch size', () => {
    const cache: ModelProfilesCache = {
      starved: entry({ '8k': { batch_sizes: [] }, '32k': { batch_sizes: [] } }),
    };
    const issues = validateModelProfilesCache(cache);

    expect(issues).toHaveLength(1);
    expect(issues[0].profile).toBe('starved');
    expect(issues[0].kind).toBe('empty-tiers');
    expect(issues[0].detail).toContain('8k, 32k');
  });

  it('reports a single tier with no batch size separately', () => {
    const cache: ModelProfilesCache = {
      partial: entry({ '8k': { batch_sizes: [2] }, '32k': { batch_sizes: [] } }),
    };
    const issues = validateModelProfilesCache(cache);

    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('empty-tier');
    expect(issues[0].detail).toContain('32k');
  });
});

describe('diffModelProfilesCaches', () => {
  const cached: ModelProfilesCache = {
    kept: entry({ '8k': { batch_sizes: [2] } }),
    gone: entry({ '8k': { batch_sizes: [2] } }),
    changed: entry({ '8k': { batch_sizes: [2] } }),
  };
  const live: ModelProfilesCache = {
    kept: entry({ '8k': { batch_sizes: [2] } }),
    changed: entry({ '8k': { batch_sizes: [2, 4] } }),
    fresh: entry({ '8k': { batch_sizes: [1] } }),
  };

  it('finds removed, changed and added profiles', () => {
    expect(diffModelProfilesCaches(cached, live)).toEqual([
      { profile: 'gone', kind: 'removed' },
      { profile: 'changed', kind: 'batching-changed' },
      { profile: 'fresh', kind: 'added' },
    ]);
  });

  it('finds nothing when the caches match', () => {
    expect(diffModelProfilesCaches(cached, cached)).toEqual([]);
  });

  it('describes the drift in one line', () => {
    const text = describeDrift(diffModelProfilesCaches(cached, live));
    expect(text).toContain('1 no longer on the cluster');
    expect(text).toContain('1 with a changed batching config');
    expect(text).toContain('1 new');
  });
});

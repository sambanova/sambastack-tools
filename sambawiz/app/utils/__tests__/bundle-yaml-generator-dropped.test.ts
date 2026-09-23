import type { Model, ModelProfile } from '../../types/bundle';
import {
  buildModelBundle,
  generateModelBundle,
  type ModelBundleSelection,
} from '../bundle-yaml-generator';
import { mockMultiArchModel } from './v3-mock-data';

/**
 * The generator removes a selection whose batching config resolves empty. These
 * tests cover what it removes, what it keeps, and what it reports.
 */

function makeModel(crname: string, arch: string, embedding = false): Model {
  return {
    metadata: { name: crname },
    spec: {
      name: crname,
      checkpoints: { [arch]: { versions: { '1': { source: `gs://ckpt/${crname}` } } } },
      metadata: { capabilities: embedding ? ['embeddings'] : ['text'] },
    },
  } as Model;
}

/** A profile whose batching config the operator published normally. */
function healthyProfile(name: string): ModelProfile {
  return {
    metadata: { name },
    spec: {
      model_arch: name,
      features: [],
      batchingConfigs: { all: { '8k': { batch_sizes: [2, 4] }, '32k': { batch_sizes: [2] } } },
      pefs: [`${name}-ss8192-bs4:1`],
    },
  } as ModelProfile;
}

/**
 * A profile that declares tiers but offers no batch size in any of them. The
 * operator publishes this when a dynamic PEF has no batch-size values.
 */
function starvedProfile(name: string): ModelProfile {
  return {
    metadata: { name },
    spec: { model_arch: name, features: [], pefs: [`${name}-ss8192-bs4:1`] },
    status: { batchingConfig: { '8k': { batch_sizes: [] }, '32k': { batch_sizes: [] } } },
  } as ModelProfile;
}

const e5Profile: ModelProfile = {
  metadata: { name: 'e5-mistral-7b' },
  spec: {
    model_arch: 'e5-mistral',
    features: [],
    batchingConfigs: { all: { '4k': { batch_sizes: [1, 4, 8, 16, 32] } } },
    pefs: ['e5-mistral-ss4096-bs32:1'],
  },
} as ModelProfile;

const sdTargetProfile: ModelProfile = {
  metadata: { name: 'llama-3p1-70b-sd' },
  spec: {
    model_arch: 'llama-3p3-70b',
    features: [],
    batchingConfigs: { all: { '8k': { batch_sizes: [2, 4] }, '32k': { batch_sizes: [2] } } },
    pefs: ['llama-3p1-70b-ss4096-bs4-sd-1:1'],
  },
} as ModelProfile;

/** Eleven selections, the last six sharing one profile builder. */
function buildSelections(tailProfile: (name: string) => ModelProfile): ModelBundleSelection[] {
  return [
    { model: mockMultiArchModel, arch: 'llama-4-maverick', profile: healthyProfile('llama-4-maverick') },
    { model: makeModel('gpt-oss-120b', 'gpt-oss'), arch: 'gpt-oss', profile: healthyProfile('gpt-oss-fp8-dyt-cd') },
    { model: makeModel('e5-mistral-7b-instruct', 'e5-mistral', true), arch: 'e5-mistral', profile: e5Profile },
    { model: makeModel('meta-llama-3-3-70b-instruct', 'llama-3p3-70b'), arch: 'llama-3p3-70b', profile: sdTargetProfile },
    { model: makeModel('qwen3-235b-a22b-instruct-2507', 'qwen3-235b'), arch: 'qwen3-235b', profile: healthyProfile('qwen-3-235b-dyt-cd') },
    {
      model: makeModel('meta-llama-3-2-1b-instruct', 'llama-3p2-1b'),
      arch: 'llama-3p2-1b',
      profile: tailProfile('llama-3p1-1b'),
      isDraftFor: 'meta-llama-3-3-70b-instruct',
    },
    { model: makeModel('qwen3-32b', 'qwen3-32b'), arch: 'qwen3-32b', profile: tailProfile('qwen-3-32b') },
    { model: makeModel('gpt-oss-20b', 'gpt-oss-20b'), arch: 'gpt-oss-20b', profile: tailProfile('gpt-oss-20b-fp8-dyt-cd') },
    { model: makeModel('gemma-4-31b-it', 'gemma4-31b'), arch: 'gemma4-31b', profile: tailProfile('gemma4-31b-dyt') },
    { model: makeModel('minimax-m2-7', 'minimax'), arch: 'minimax', profile: tailProfile('minimax-m2p5-dyt') },
    { model: makeModel('mistral-large-3-675b-instruct-2512', 'mistral-large-3'), arch: 'mistral-large-3', profile: tailProfile('mistral-large-3') },
  ];
}

describe('buildModelBundle reports what it drops', () => {
  it('keeps every selection when each profile publishes batch sizes', () => {
    const { bundle, dropped } = buildModelBundle('full-bundle', buildSelections(healthyProfile));

    expect(bundle.spec.modelConfigs).toHaveLength(11);
    expect(bundle.spec.specDecodingPairs).toEqual([
      { draft: 'meta-llama-3-2-1b-instruct', target: 'meta-llama-3-3-70b-instruct' },
    ]);
    expect(dropped).toEqual([]);
  });

  it('names every model it drops for an unresolvable profile default', () => {
    const { bundle, dropped } = buildModelBundle('starved-bundle', buildSelections(starvedProfile));

    expect(bundle.spec.modelConfigs).toHaveLength(5);
    expect(dropped.map((d) => d.model)).toEqual([
      'meta-llama-3-2-1b-instruct',
      'qwen3-32b',
      'gpt-oss-20b',
      'gemma-4-31b-it',
      'minimax-m2-7',
      'mistral-large-3-675b-instruct-2512',
    ]);
    expect(dropped.every((d) => d.reason === 'profile-batching-unresolved')).toBe(true);
  });

  it('reports a dropped spec-decoding draft, whose pair also leaves', () => {
    const { bundle, dropped } = buildModelBundle('starved-bundle', buildSelections(starvedProfile));

    expect(bundle.spec.specDecodingPairs).toBeUndefined();
    expect(dropped).toContainEqual({
      model: 'meta-llama-3-2-1b-instruct',
      profile: 'llama-3p1-1b',
      reason: 'profile-batching-unresolved',
    });
  });

  it('separates a user-cleared batching config from an unresolvable one', () => {
    const selections = buildSelections(healthyProfile).map((sel, i) =>
      i === 6 ? { ...sel, batchingConfigOverride: { '8k': { batch_sizes: [] as number[] } } } : sel
    );
    const { dropped } = buildModelBundle('cleared-bundle', selections);

    expect(dropped).toEqual([
      { model: 'qwen3-32b', profile: 'qwen-3-32b', reason: 'batching-config-cleared' },
    ]);
  });

  it('generateModelBundle passes the dropped selections to its caller', () => {
    const { yaml, dropped } = generateModelBundle('starved-bundle', buildSelections(starvedProfile));

    expect(yaml).toContain('kind: ModelBundle');
    expect(dropped).toHaveLength(6);
  });
});

describe('an override with no tiers falls back to the profile default', () => {
  it('keeps a model whose override is an empty object', () => {
    const profile = healthyProfile('qwen-3-32b');
    const selection: ModelBundleSelection = {
      model: makeModel('qwen3-32b', 'qwen3-32b'),
      arch: 'qwen3-32b',
      profile,
      batchingConfigOverride: {},
    };

    const { bundle, dropped } = buildModelBundle('empty-override', [selection]);

    expect(bundle.spec.modelConfigs).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it('treats an empty override and an absent override the same way', () => {
    const selections = buildSelections(healthyProfile);
    const withEmptyOverrides = selections.map((sel) => ({ ...sel, batchingConfigOverride: {} }));

    expect(generateModelBundle('b', withEmptyOverrides).yaml).toEqual(
      generateModelBundle('b', selections).yaml
    );
  });
});

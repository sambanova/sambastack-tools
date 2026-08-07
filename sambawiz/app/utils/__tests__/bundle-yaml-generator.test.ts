import yaml from 'js-yaml';
import {
  formatModelRef,
  formatModelRefLatest,
  isEmbeddingModel,
  getEffectiveBatchingConfig,
  deriveIsDefaultTier,
  batchingConfigsEqual,
  collapseTiersToWildcard,
  resolveWildcardTiers,
  orderBatchingConfigDescending,
  getDisplayName,
  isSpecDecodingProfile,
  buildModelBundleObject,
  generateModelBundleYaml,
  getHighestVersion,
  type ModelBundleSelection,
} from '../bundle-yaml-generator';
import {
  mockSingleArchModel,
  mockMultiArchModel,
  mockEmbeddingModel,
  mockSpecDecodingTargetModel,
  mockSpecDecodingDraftModel,
  mockContinuousBatchingProfile,
  mockHighInteractivityProfile,
  mockSpecDecodingTargetProfile,
  mockSpecDecodingDraftProfile,
} from './v3-mock-data';

describe('bundle-yaml-generator', () => {
  describe('getHighestVersion', () => {
    it('picks the numeric-highest version, not lexicographically-highest', () => {
      const model = {
        metadata: { name: 'm' },
        spec: {
          name: 'M',
          checkpoints: {
            arch: {
              versions: {
                '1': { source: 'gs://a' },
                '2': { source: 'gs://b' },
                '10': { source: 'gs://c' },
              },
            },
          },
          metadata: { capabilities: [] },
        },
      };
      expect(getHighestVersion(model, 'arch')).toBe('10');
    });
  });

  describe('formatModelRef', () => {
    it('formats single-arch models as crname:version', () => {
      expect(formatModelRef(mockSingleArchModel, 'e5-mistral')).toBe('e5-mistral-7b-instruct:1');
    });

    it('formats multi-arch models as crname:arch:version', () => {
      expect(formatModelRef(mockMultiArchModel, 'llama-4-maverick')).toBe(
        'llama-4-maverick-17b-128e-instruct:llama-4-maverick:1'
      );
      expect(formatModelRef(mockMultiArchModel, 'llama-4-maverick-v2')).toBe(
        'llama-4-maverick-17b-128e-instruct:llama-4-maverick-v2:1'
      );
    });

    it('uses an explicit version override in place of the latest version', () => {
      expect(formatModelRef(mockSingleArchModel, 'e5-mistral', '3')).toBe('e5-mistral-7b-instruct:3');
      expect(formatModelRef(mockMultiArchModel, 'llama-4-maverick', '2')).toBe(
        'llama-4-maverick-17b-128e-instruct:llama-4-maverick:2'
      );
    });
  });

  describe('formatModelRefLatest', () => {
    it('formats single-arch models as bare crname (no arch, no version → latest)', () => {
      expect(formatModelRefLatest(mockSingleArchModel, 'e5-mistral')).toBe('e5-mistral-7b-instruct');
    });

    it('formats multi-arch models as crname:arch (no version → latest)', () => {
      expect(formatModelRefLatest(mockMultiArchModel, 'llama-4-maverick')).toBe(
        'llama-4-maverick-17b-128e-instruct:llama-4-maverick'
      );
      expect(formatModelRefLatest(mockMultiArchModel, 'llama-4-maverick-v2')).toBe(
        'llama-4-maverick-17b-128e-instruct:llama-4-maverick-v2'
      );
    });

    it('pins the version override when provided (instead of omitting it for latest)', () => {
      expect(formatModelRefLatest(mockSingleArchModel, 'e5-mistral', '3')).toBe('e5-mistral-7b-instruct:3');
      expect(formatModelRefLatest(mockMultiArchModel, 'llama-4-maverick', '2')).toBe(
        'llama-4-maverick-17b-128e-instruct:llama-4-maverick:2'
      );
    });
  });

  describe('isEmbeddingModel', () => {
    it('is true when capabilities includes "embeddings"', () => {
      expect(isEmbeddingModel(mockEmbeddingModel)).toBe(true);
      expect(isEmbeddingModel(mockSingleArchModel)).toBe(true);
    });

    it('is false otherwise', () => {
      expect(isEmbeddingModel(mockMultiArchModel)).toBe(false);
      expect(isEmbeddingModel(mockSpecDecodingTargetModel)).toBe(false);
    });
  });

  describe('getEffectiveBatchingConfig', () => {
    it('prefers spec.defaultBatchingConfig over status.batchingConfig', () => {
      const result = getEffectiveBatchingConfig(mockContinuousBatchingProfile);
      expect(result).toEqual(mockContinuousBatchingProfile.spec.defaultBatchingConfig);
    });

    it('falls back to status.batchingConfig when spec has none', () => {
      const profile = {
        metadata: { name: 'p' },
        spec: { model_arch: 'a', features: [], pefs: [] },
        status: { batchingConfig: { '8k': { batch_sizes: [1] } } },
      };
      expect(getEffectiveBatchingConfig(profile)).toEqual({ '8k': { batch_sizes: [1] } });
    });

    it('falls back to {} when neither is present', () => {
      const profile = { metadata: { name: 'p' }, spec: { model_arch: 'a', features: [], pefs: [] } };
      expect(getEffectiveBatchingConfig(profile)).toEqual({});
    });
  });

  describe('deriveIsDefaultTier', () => {
    const config = {
      '8k': { batch_sizes: [2, 4] as number[] },
      '32k': { batch_sizes: [2] as number[] },
      '128k': { batch_sizes: [1] as number[] },
    };

    it('sets is_default on the smallest tier for embedding models', () => {
      const result = deriveIsDefaultTier(config, true);
      expect(result['8k'].is_default).toBe(true);
      expect(result['32k'].is_default).toBeUndefined();
      expect(result['128k'].is_default).toBeUndefined();
    });

    it('never sets is_default for non-embedding models', () => {
      const result = deriveIsDefaultTier(config, false);
      expect(result['8k'].is_default).toBeUndefined();
      expect(result['32k'].is_default).toBeUndefined();
      expect(result['128k'].is_default).toBeUndefined();
    });

    it('strips any pre-existing is_default when not embedding', () => {
      const withDefault = { '8k': { batch_sizes: [1] as number[], is_default: true } };
      const result = deriveIsDefaultTier(withDefault, false);
      expect(result['8k'].is_default).toBeUndefined();
    });

    it('handles bare-int and t-suffixed tier keys', () => {
      const mixed = { '448': { batch_sizes: [1] as number[] }, '10t': { batch_sizes: [2] as number[] } };
      const result = deriveIsDefaultTier(mixed, true);
      expect(result['10t'].is_default).toBe(true);
      expect(result['448'].is_default).toBeUndefined();
    });

    it('returns an empty object for an empty config', () => {
      expect(deriveIsDefaultTier({}, true)).toEqual({});
    });
  });

  describe('batchingConfigsEqual', () => {
    it('is true regardless of tier order and batch-size order', () => {
      const a = { '8k': { batch_sizes: [2, 4] as number[] }, '32k': { batch_sizes: [1] as number[] } };
      const b = { '32k': { batch_sizes: [1] as number[] }, '8k': { batch_sizes: [4, 2] as number[] } };
      expect(batchingConfigsEqual(a, b)).toBe(true);
    });

    it('is false when tiers, batch sizes, or is_default differ', () => {
      const base = { '8k': { batch_sizes: [1] as number[] } };
      expect(batchingConfigsEqual(base, { '8k': { batch_sizes: [1, 2] as number[] } })).toBe(false);
      expect(batchingConfigsEqual(base, { '8k': { batch_sizes: [1] as number[] }, '32k': { batch_sizes: [1] as number[] } })).toBe(false);
      expect(batchingConfigsEqual(base, { '8k': { batch_sizes: [1] as number[], is_default: true } })).toBe(false);
      expect(batchingConfigsEqual({ '8k': { batch_sizes: '*' as const } }, { '8k': { batch_sizes: [1] as number[] } })).toBe(false);
    });
  });

  describe('collapseTiersToWildcard', () => {
    const profileDefault = {
      '8k': { batch_sizes: [2, 4, 6, 8] as number[] },
      '32k': { batch_sizes: [2, 4] as number[] },
    };

    it("replaces a tier's batch_sizes with '*' when they match the profile default (order-independent)", () => {
      const result = collapseTiersToWildcard({ '8k': { batch_sizes: [8, 6, 4, 2] } }, profileDefault);
      expect(result['8k'].batch_sizes).toBe('*');
    });

    it('leaves batch_sizes untouched when they differ from the default or the default has no such tier', () => {
      const result = collapseTiersToWildcard(
        { '8k': { batch_sizes: [2, 4] }, '128k': { batch_sizes: [1] } },
        profileDefault
      );
      expect(result['8k'].batch_sizes).toEqual([2, 4]);
      expect(result['128k'].batch_sizes).toEqual([1]);
    });

    it('preserves is_default while collapsing the matching tier', () => {
      const result = collapseTiersToWildcard({ '8k': { batch_sizes: [2, 4, 6, 8], is_default: true } }, profileDefault);
      expect(result['8k']).toEqual({ batch_sizes: '*', is_default: true });
    });
  });

  describe('resolveWildcardTiers', () => {
    const profileDefault = {
      '8k': { batch_sizes: [2, 4, 6, 8] as number[] },
      '32k': { batch_sizes: [2, 4] as number[] },
    };

    it("expands a tier's '*' sentinel to the profile default's batch sizes", () => {
      const result = resolveWildcardTiers({ '8k': { batch_sizes: '*' } }, profileDefault);
      expect(result['8k'].batch_sizes).toEqual([2, 4, 6, 8]);
    });

    it('leaves explicit batch sizes untouched, and passes through a wildcard with no matching default', () => {
      const result = resolveWildcardTiers(
        { '8k': { batch_sizes: [2] }, '128k': { batch_sizes: '*' } },
        profileDefault
      );
      expect(result['8k'].batch_sizes).toEqual([2]);
      expect(result['128k'].batch_sizes).toBe('*');
    });

    it('preserves is_default while expanding the wildcard tier', () => {
      const result = resolveWildcardTiers({ '8k': { batch_sizes: '*', is_default: true } }, profileDefault);
      expect(result['8k']).toEqual({ batch_sizes: [2, 4, 6, 8], is_default: true });
    });

    it("round-trips with collapseTiersToWildcard (expand ∘ collapse leaves a matching tier at the default)", () => {
      const collapsed = collapseTiersToWildcard({ '8k': { batch_sizes: [8, 6, 4, 2] } }, profileDefault);
      expect(collapsed['8k'].batch_sizes).toBe('*');
      const resolved = resolveWildcardTiers(collapsed, profileDefault);
      expect(resolved['8k'].batch_sizes).toEqual([2, 4, 6, 8]);
    });
  });

  describe('orderBatchingConfigDescending', () => {
    it('reinserts tiers in descending sequence-length order', () => {
      const config = {
        '128k': { batch_sizes: [2] as number[] },
        '8k': { batch_sizes: [2] as number[] },
        '192k': { batch_sizes: [2] as number[] },
        '32k': { batch_sizes: [2] as number[] },
        '64k': { batch_sizes: [2] as number[] },
      };
      expect(Object.keys(orderBatchingConfigDescending(config))).toEqual(['192k', '128k', '64k', '32k', '8k']);
    });
  });

  describe('getDisplayName', () => {
    it('maps continuous_batching to "High Throughput"', () => {
      expect(getDisplayName(mockContinuousBatchingProfile, [mockContinuousBatchingProfile])).toBe(
        'High Throughput'
      );
    });

    it('maps empty features to "High Interactivity"', () => {
      expect(getDisplayName(mockHighInteractivityProfile, [mockHighInteractivityProfile])).toBe(
        'High Interactivity'
      );
    });

    it('leaves a lone profile of a type unnumbered', () => {
      const siblings = [mockHighInteractivityProfile, mockContinuousBatchingProfile];
      expect(getDisplayName(mockHighInteractivityProfile, siblings)).toBe('High Interactivity');
      expect(getDisplayName(mockContinuousBatchingProfile, siblings)).toBe('High Throughput');
    });

    it('numbers profiles of the same type in listing order', () => {
      const hi2 = {
        metadata: { name: 'hi-2' },
        spec: { model_arch: 'a', features: [], pefs: [] },
      };
      const siblings = [mockHighInteractivityProfile, hi2];
      expect(getDisplayName(mockHighInteractivityProfile, siblings)).toBe('High Interactivity 1');
      expect(getDisplayName(hi2, siblings)).toBe('High Interactivity 2');
    });
  });

  describe('isSpecDecodingProfile', () => {
    it('is true when a pef name contains "sd"', () => {
      expect(isSpecDecodingProfile(mockSpecDecodingTargetProfile)).toBe(true);
    });

    it('is false when no pef name contains "sd"', () => {
      expect(isSpecDecodingProfile(mockContinuousBatchingProfile)).toBe(false);
      expect(isSpecDecodingProfile(mockHighInteractivityProfile)).toBe(false);
      expect(isSpecDecodingProfile(mockSpecDecodingDraftProfile)).toBe(false);
    });
  });

  describe('buildModelBundleObject / generateModelBundleYaml', () => {
    it('emits one modelConfigs entry per selection (batchingConfig present here since the embedding is_default diverges from the profile default)', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile },
      ];
      const bundle = buildModelBundleObject('my-bundle', selections);

      expect(bundle.metadata.name).toBe('my-bundle');
      expect(bundle.spec.modelConfigs).toHaveLength(1);
      const entry = bundle.spec.modelConfigs[0];
      expect(entry.model).toBe('e5-mistral-7b-instruct:1');
      expect(entry.profile).toBe('gpt-oss-fp8-dyt');
      // mockSingleArchModel is an embedding model, so is_default is added to the
      // smallest tier — a divergence from the profile default that forces emission.
      expect(entry.batchingConfig).toBeDefined();
      expect(entry.modelSettings).toBeUndefined();
    });

    it('applies is_default to the smallest tier only for embedding models', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockEmbeddingModel, arch: 'gte-qwen2', profile: mockHighInteractivityProfile },
      ];
      const bundle = buildModelBundleObject('embed-bundle', selections);
      const batchingConfig = bundle.spec.modelConfigs[0].batchingConfig!;
      expect(batchingConfig['8k'].is_default).toBe(true);
      expect(batchingConfig['32k'].is_default).toBeUndefined();
      expect(batchingConfig['64k'].is_default).toBeUndefined();
      expect(batchingConfig['128k'].is_default).toBeUndefined();
    });

    it('never sets is_default for non-embedding models', () => {
      const selections: ModelBundleSelection[] = [
        {
          model: mockMultiArchModel,
          arch: 'llama-4-maverick',
          profile: mockHighInteractivityProfile,
          // Diverge from the profile default so batchingConfig is emitted.
          batchingConfigOverride: { '8k': { batch_sizes: [2] } },
        },
      ];
      const bundle = buildModelBundleObject('non-embed-bundle', selections);
      const batchingConfig = bundle.spec.modelConfigs[0].batchingConfig!;
      Object.values(batchingConfig).forEach((tier) => expect(tier.is_default).toBeUndefined());
    });

    it('omits batchingConfig when it matches the profile default (non-embedding, no override)', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockMultiArchModel, arch: 'llama-4-maverick', profile: mockHighInteractivityProfile },
      ];
      const bundle = buildModelBundleObject('default-bundle', selections);
      expect(bundle.spec.modelConfigs[0].batchingConfig).toBeUndefined();
    });

    it('omits batchingConfig when an override exactly matches the profile default', () => {
      const selections: ModelBundleSelection[] = [
        {
          model: mockMultiArchModel,
          arch: 'llama-4-maverick',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: { ...mockHighInteractivityProfile.spec.defaultBatchingConfig },
        },
      ];
      const bundle = buildModelBundleObject('default-bundle', selections);
      expect(bundle.spec.modelConfigs[0].batchingConfig).toBeUndefined();
    });

    it("omits batchingConfig when every tier is the '*' wildcard (all batch sizes left checked)", () => {
      // Reproduces the "batchingConfig full of '*'" bug: an override that leaves
      // every tier at the wildcard is semantically the profile default, so the
      // whole batchingConfig must be omitted (not emitted as all-'*').
      const selections: ModelBundleSelection[] = [
        {
          model: mockMultiArchModel,
          arch: 'llama-4-maverick',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: {
            '8k': { batch_sizes: '*' },
            '32k': { batch_sizes: '*' },
            '64k': { batch_sizes: '*' },
            '128k': { batch_sizes: '*' },
          },
        },
      ];
      const bundle = buildModelBundleObject('wildcard-default-bundle', selections);
      expect(bundle.spec.modelConfigs[0].batchingConfig).toBeUndefined();
    });

    it("still emits batchingConfig when some tiers are '*' but another diverges from the default", () => {
      const selections: ModelBundleSelection[] = [
        {
          model: mockMultiArchModel,
          arch: 'llama-4-maverick',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: {
            '8k': { batch_sizes: '*' }, // matches default [2, 4, 6, 8]
            '32k': { batch_sizes: '*' }, // matches default [2, 4, 6, 8]
            '64k': { batch_sizes: [2] }, // diverges from default [2, 4]
            '128k': { batch_sizes: '*' }, // matches default [2]
          },
        },
      ];
      const batchingConfig = buildModelBundleObject('wildcard-partial-bundle', selections).spec
        .modelConfigs[0].batchingConfig;
      expect(batchingConfig).toBeDefined();
      // The divergent tier keeps its explicit list; matching tiers stay '*'.
      expect(batchingConfig!['64k'].batch_sizes).toEqual([2]);
      expect(batchingConfig!['8k'].batch_sizes).toBe('*');
    });

    it('drops a model entirely when all its batching tiers are cleared in Step 3', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockMultiArchModel, arch: 'llama-4-maverick', profile: mockHighInteractivityProfile },
        {
          model: mockSingleArchModel,
          arch: 'e5-mistral',
          profile: mockHighInteractivityProfile,
          // Every tier unchecked → empty override, while the profile default was non-empty.
          batchingConfigOverride: { '8k': { batch_sizes: [] }, '32k': { batch_sizes: [] } },
        },
      ];
      const bundle = buildModelBundleObject('drop-bundle', selections);
      expect(bundle.spec.modelConfigs).toHaveLength(1);
      expect(bundle.spec.modelConfigs[0].model).toBe('llama-4-maverick-17b-128e-instruct:llama-4-maverick:1');
    });

    it('prunes a spec-decoding pair whose target model was dropped', () => {
      const selections: ModelBundleSelection[] = [
        {
          // Target model: batching fully cleared → dropped.
          model: mockSpecDecodingTargetModel,
          arch: 'llama-3p3-70b',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: { '8k': { batch_sizes: [] } },
        },
        {
          // Draft model referencing the (now-dropped) target.
          model: mockSpecDecodingDraftModel,
          arch: 'llama-3p2-1b',
          profile: mockSpecDecodingDraftProfile,
          isDraftFor: mockSpecDecodingTargetModel.metadata.name,
        },
      ];
      const bundle = buildModelBundleObject('sd-drop-bundle', selections);
      expect(bundle.spec.modelConfigs.map((c) => c.model)).toEqual(['meta-llama-3-2-1b-instruct:1']);
      expect(bundle.spec.specDecodingPairs).toBeUndefined();
    });

    it('orders an emitted batchingConfig by descending sequence length in the YAML', () => {
      const override = {
        '8k': { batch_sizes: [2, 4] as number[] },
        '128k': { batch_sizes: [2] as number[] },
        '32k': { batch_sizes: [2, 4] as number[] },
        '64k': { batch_sizes: [2] as number[] },
        '192k': { batch_sizes: [2] as number[] },
      };
      const selections: ModelBundleSelection[] = [
        {
          model: mockMultiArchModel,
          arch: 'llama-4-maverick',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: override,
        },
      ];
      const yamlStr = generateModelBundleYaml('order-bundle', selections);
      // Word-boundary match so "8k:" doesn't match inside "128k:".
      const indices = ['192k', '128k', '64k', '32k', '8k'].map((tier) =>
        yamlStr.search(new RegExp(`\\b${tier}:`))
      );
      indices.forEach((idx) => expect(idx).toBeGreaterThan(-1));
      // Tiers appear in strictly descending-seq-length order → indices ascending.
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    });

    it('renders batch_sizes as flow-style arrays and collapses tiers matching the profile default to "*"', () => {
      // mockHighInteractivityProfile default: 8k [2,4,6,8], 32k [2,4,6,8], 64k [2,4], 128k [2].
      const override = {
        '8k': { batch_sizes: [2, 4, 6, 8] as number[] }, // matches default → '*'
        '32k': { batch_sizes: [1] as number[] }, // differs → [1]
        '64k': { batch_sizes: [2, 4] as number[] }, // matches default → '*'
        '128k': { batch_sizes: [1, 2] as number[] }, // differs → [1, 2]
      };
      const selections: ModelBundleSelection[] = [
        {
          model: mockMultiArchModel, // non-embedding → no is_default noise
          arch: 'llama-4-maverick',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: override,
        },
      ];
      const yamlStr = generateModelBundleYaml('flow-bundle', selections);

      // Flow-style arrays, one line each (no block "- 1" list items under batch_sizes).
      expect(yamlStr).toContain('batch_sizes: [1]');
      expect(yamlStr).toContain('batch_sizes: [1, 2]');
      expect(yamlStr).not.toMatch(/batch_sizes:\n\s+-/);
      // Tiers left at the profile default collapse to the '*' sentinel.
      expect(yamlStr).toContain("batch_sizes: '*'");
      // The YAML still parses back to the ModelBundle shape.
      const parsed = yaml.load(yamlStr) as { spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> } };
      const cfg = parsed.spec.modelConfigs[0].batchingConfig;
      expect(cfg['8k'].batch_sizes).toBe('*');
      expect(cfg['32k'].batch_sizes).toEqual([1]);
      expect(cfg['64k'].batch_sizes).toBe('*');
      expect(cfg['128k'].batch_sizes).toEqual([1, 2]);
    });

    it('uses batchingConfigOverride instead of the profile default when present', () => {
      const override = { '8k': { batch_sizes: [1] as number[] } };
      const selections: ModelBundleSelection[] = [
        {
          model: mockSingleArchModel,
          arch: 'e5-mistral',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: override,
        },
      ];
      const bundle = buildModelBundleObject('override-bundle', selections);
      // The override's batch_sizes ([1], not the profile default) is what's used. mockSingleArchModel
      // is an embedding model, so is_default:true is auto-added to the smallest (only) tier per Q2.
      expect(bundle.spec.modelConfigs[0].batchingConfig).toEqual({ '8k': { batch_sizes: [1], is_default: true } });
    });

    it('drops tiers whose batch_sizes were fully unchecked in the override (no empty batch_sizes emitted)', () => {
      const override = {
        '8k': { batch_sizes: [] as number[] },
        '32k': { batch_sizes: [2, 4] as number[] },
        '64k': { batch_sizes: '*' as const },
      };
      const selections: ModelBundleSelection[] = [
        {
          model: mockMultiArchModel,
          arch: 'llama-4-maverick',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: override,
        },
      ];
      const batchingConfig = buildModelBundleObject('drop-empty-bundle', selections).spec.modelConfigs[0].batchingConfig!;
      expect(batchingConfig).not.toHaveProperty('8k');
      expect(batchingConfig['32k'].batch_sizes).toEqual([2, 4]);
      expect(batchingConfig['64k'].batch_sizes).toBe('*');
    });

    it('re-targets is_default to the smallest remaining tier after empty tiers are dropped (embedding)', () => {
      // mockEmbeddingModel's profile has tiers 8k/32k/64k/128k; unchecking 8k should move is_default to 32k.
      const override = {
        '8k': { batch_sizes: [] as number[] },
        '32k': { batch_sizes: [1] as number[] },
        '64k': { batch_sizes: [1] as number[] },
        '128k': { batch_sizes: [1] as number[] },
      };
      const selections: ModelBundleSelection[] = [
        {
          model: mockEmbeddingModel,
          arch: 'gte-qwen2',
          profile: mockHighInteractivityProfile,
          batchingConfigOverride: override,
        },
      ];
      const batchingConfig = buildModelBundleObject('drop-empty-embed', selections).spec.modelConfigs[0].batchingConfig!;
      expect(batchingConfig).not.toHaveProperty('8k');
      expect(batchingConfig['32k'].is_default).toBe(true);
      expect(batchingConfig['64k'].is_default).toBeUndefined();
    });

    it('builds specDecodingPairs with bare crnames and no experts field, and marks the draft routable:false', () => {
      const selections: ModelBundleSelection[] = [
        {
          model: mockSpecDecodingDraftModel,
          arch: 'llama-3p2-1b',
          profile: mockSpecDecodingDraftProfile,
          isDraftFor: mockSpecDecodingTargetModel.metadata.name,
        },
        {
          model: mockSpecDecodingTargetModel,
          arch: 'llama-3p3-70b',
          profile: mockSpecDecodingTargetProfile,
        },
      ];
      const bundle = buildModelBundleObject('spec-decode-bundle', selections);

      expect(bundle.spec.specDecodingPairs).toEqual([
        { draft: 'meta-llama-3-2-1b-instruct', target: 'meta-llama-3-3-70b-instruct' },
      ]);
      expect(bundle.spec.specDecodingPairs?.[0]).not.toHaveProperty('experts');

      const draftEntry = bundle.spec.modelConfigs.find((c) => c.model.startsWith('meta-llama-3-2-1b-instruct'));
      const targetEntry = bundle.spec.modelConfigs.find((c) => c.model.startsWith('meta-llama-3-3-70b-instruct'));
      expect(draftEntry?.modelSettings).toEqual({ routable: false });
      expect(targetEntry?.modelSettings).toBeUndefined();
    });

    it('omits modelSettings when swappable is true, undefined, or unset (the operator default)', () => {
      const cases: ModelBundleSelection[] = [
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile },
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile, swappable: true },
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile, swappable: undefined },
      ];
      cases.forEach((selection) => {
        const bundle = buildModelBundleObject('swap-default-bundle', [selection]);
        expect(bundle.spec.modelConfigs[0].modelSettings).toBeUndefined();
      });
    });

    it('emits modelSettings.swappable:false only when swappable is explicitly false', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile, swappable: false },
      ];
      const bundle = buildModelBundleObject('swap-off-bundle', selections);
      expect(bundle.spec.modelConfigs[0].modelSettings).toEqual({ swappable: false });
    });

    it('merges routable:false and swappable:false into a single modelSettings for a non-swappable draft', () => {
      const selections: ModelBundleSelection[] = [
        {
          model: mockSpecDecodingDraftModel,
          arch: 'llama-3p2-1b',
          profile: mockSpecDecodingDraftProfile,
          isDraftFor: mockSpecDecodingTargetModel.metadata.name,
          swappable: false,
        },
        {
          model: mockSpecDecodingTargetModel,
          arch: 'llama-3p3-70b',
          profile: mockSpecDecodingTargetProfile,
        },
      ];
      const bundle = buildModelBundleObject('draft-noswap-bundle', selections);
      const draftEntry = bundle.spec.modelConfigs.find((c) => c.model.startsWith('meta-llama-3-2-1b-instruct'));
      expect(draftEntry?.modelSettings).toEqual({ routable: false, swappable: false });
    });

    it('omits specDecodingPairs entirely when there are none', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile },
      ];
      const bundle = buildModelBundleObject('no-sd-bundle', selections);
      expect(bundle.spec.specDecodingPairs).toBeUndefined();
    });

    it('generates a ModelBundle YAML document with apiVersion/kind/metadata.name and no secretNames', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile },
      ];
      const yamlStr = generateModelBundleYaml('yaml-bundle', selections);
      const parsed = yaml.load(yamlStr) as Record<string, unknown>;

      expect(parsed.apiVersion).toBe('sambanova.ai/v1alpha1');
      expect(parsed.kind).toBe('ModelBundle');
      expect((parsed.metadata as { name: string }).name).toBe('yaml-bundle');
      expect(parsed.spec).not.toHaveProperty('secretNames');
      expect(yamlStr).not.toMatch(/secretNames/);
    });

    it('matches the field order from the worked spec-decoding example (model, profile, modelSettings, batchingConfig)', () => {
      const selections: ModelBundleSelection[] = [
        {
          model: mockSpecDecodingDraftModel,
          arch: 'llama-3p2-1b',
          profile: mockSpecDecodingDraftProfile,
          isDraftFor: mockSpecDecodingTargetModel.metadata.name,
          // Diverge from the profile default so batchingConfig is emitted (a config
          // matching the default is now omitted).
          batchingConfigOverride: { '4k': { batch_sizes: [1] } },
        },
      ];
      const yamlStr = generateModelBundleYaml('order-bundle', selections);
      const modelIdx = yamlStr.indexOf('model:');
      const profileIdx = yamlStr.indexOf('profile:');
      const modelSettingsIdx = yamlStr.indexOf('modelSettings:');
      const batchingConfigIdx = yamlStr.indexOf('batchingConfig:');

      expect(modelIdx).toBeLessThan(profileIdx);
      expect(profileIdx).toBeLessThan(modelSettingsIdx);
      expect(modelSettingsIdx).toBeLessThan(batchingConfigIdx);
    });
  });
});

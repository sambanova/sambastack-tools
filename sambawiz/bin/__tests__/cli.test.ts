import type { CheckpointMappingV3, ModelProfilesCache } from '../../app/types/bundle';
import { generateModelBundleYaml, type ModelBundleSelection } from '../../app/utils/bundle-yaml-generator';
import {
  toModelCR,
  toModelProfileCR,
  getArchsWithProfiles,
  getProfilesForArch,
  parseBatchSizesInput,
  crNameToDisplayName,
  extractBundleName,
  buildModelDeploymentYaml,
  readValidCondition,
} from '../cli';

/**
 * Tests for the V3 CLI's pure business logic (bin/cli.ts) — the cache→CR
 * adapters that let the CLI drive the shared generator/parser
 * (bundle-yaml-generator.ts / parse-bundle-yaml.ts) from the
 * `checkpoint_mapping.json` (CheckpointMappingV3) / `model_profiles.json`
 * (ModelProfilesCache) caches, per v3plan.md's "V3 SambaWiz UX &
 * implementation plan" and "CLI is in scope (Q13)".
 *
 * Interactive/kubectl-dependent code (menus, spinners, apply/monitor loops)
 * is intentionally not covered here, matching this repo's test philosophy
 * (see TESTS.md): test business logic and data transforms, not the
 * interactive shell.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const checkpointMapping: CheckpointMappingV3 = {
  'Llama-3-8B-Instruct': {
    resource_name: 'llama-3-8b-instruct',
    checkpoints: {
      'llama-3-8b': {
        versions: {
          '1': { source: 'ckpts/llama-3-8b/v1' },
          '2': { source: 'ckpts/llama-3-8b/v2', checkpoint_status: 'stable' },
        },
      },
    },
    capabilities: ['text'],
  },
  'Multi-Arch-Model': {
    resource_name: 'multi-arch-model',
    checkpoints: {
      'arch-a': { versions: { '1': { source: 'ckpts/arch-a/v1', checkpoint_status: 'stable' } } },
      'arch-b': { versions: { '1': { source: 'ckpts/arch-b/v1', checkpoint_status: 'preview' } } },
    },
    capabilities: ['text'],
  },
  'Embed-Model': {
    resource_name: 'embed-model',
    checkpoints: {
      'embed-arch': { versions: { '1': { source: 'ckpts/embed/v1' } } },
    },
    capabilities: ['embeddings'],
  },
  'No-Profile-Model': {
    resource_name: 'no-profile-model',
    checkpoints: {
      'unmapped-arch': { versions: { '1': { source: 'ckpts/unmapped/v1' } } },
    },
    capabilities: ['text'],
  },
  'Draft-Model': {
    resource_name: 'draft-model',
    checkpoints: {
      'draft-arch': { versions: { '1': { source: 'ckpts/draft/v1' } } },
    },
    capabilities: ['text'],
  },
};

const modelProfiles: ModelProfilesCache = {
  'llama-3-8b-profile': {
    model_arch: 'llama-3-8b',
    features: [],
    batchingConfig: { '8k': { batch_sizes: [1, 2] } },
    pefs: ['llama-3-8b-ss8192-bs2:1'],
  },
  'arch-a-profile': {
    model_arch: 'arch-a',
    features: ['continuous_batching'],
    batchingConfig: { '4k': { batch_sizes: [1] } },
    pefs: ['arch-a-ss4096-bs1-cb:1'],
  },
  'embed-profile': {
    model_arch: 'embed-arch',
    features: [],
    batchingConfig: {
      '2k': { batch_sizes: [1] },
      '8k': { batch_sizes: [1] },
    },
    pefs: ['embed-ss2048-bs1:1'],
  },
  'sd-target-profile': {
    model_arch: 'llama-3-8b-sd-target',
    features: [],
    batchingConfig: { '4k': { batch_sizes: [1] } },
    pefs: ['target-ss4096-bs1-sd5:1'],
  },
  'draft-profile': {
    model_arch: 'draft-arch',
    features: [],
    batchingConfig: { '4k': { batch_sizes: [1] } },
    pefs: ['draft-ss4096-bs1:1'],
  },
};

// ─── toModelCR / toModelProfileCR ────────────────────────────────────────────

describe('toModelCR', () => {
  it('converts a CheckpointMappingV3 entry into a Model CR', () => {
    const model = toModelCR('Llama-3-8B-Instruct', checkpointMapping['Llama-3-8B-Instruct']);
    expect(model.metadata.name).toBe('llama-3-8b-instruct');
    expect(model.spec.name).toBe('Llama-3-8B-Instruct');
    expect(model.spec.checkpoints).toBe(checkpointMapping['Llama-3-8B-Instruct'].checkpoints);
    expect(model.spec.metadata.capabilities).toEqual(['text']);
  });

  it('carries "embeddings" capability through for embedding models', () => {
    const model = toModelCR('Embed-Model', checkpointMapping['Embed-Model']);
    expect(model.spec.metadata.capabilities).toEqual(['embeddings']);
  });
});

describe('toModelProfileCR', () => {
  it('converts a ModelProfilesCache entry into a ModelProfile CR', () => {
    const profile = toModelProfileCR('arch-a-profile', modelProfiles['arch-a-profile']);
    expect(profile.metadata.name).toBe('arch-a-profile');
    expect(profile.spec.model_arch).toBe('arch-a');
    expect(profile.spec.features).toEqual(['continuous_batching']);
    expect(profile.spec.defaultBatchingConfig).toBe(modelProfiles['arch-a-profile'].batchingConfig);
    expect(profile.spec.pefs).toEqual(['arch-a-ss4096-bs1-cb:1']);
  });
});

// ─── getArchsWithProfiles / getProfilesForArch ───────────────────────────────

describe('getArchsWithProfiles', () => {
  it('returns the single arch for a single-arch model with a matching profile', () => {
    const archs = getArchsWithProfiles(checkpointMapping['Llama-3-8B-Instruct'].checkpoints, modelProfiles);
    expect(archs).toEqual(['llama-3-8b']);
  });

  it('filters out archs with no matching ModelProfile (multi-arch)', () => {
    const archs = getArchsWithProfiles(checkpointMapping['Multi-Arch-Model'].checkpoints, modelProfiles);
    // arch-b has no profile in the cache — only arch-a should surface.
    expect(archs).toEqual(['arch-a']);
  });

  it('returns an empty array when no arch has a matching profile (Q4 no-profile guard)', () => {
    const archs = getArchsWithProfiles(checkpointMapping['No-Profile-Model'].checkpoints, modelProfiles);
    expect(archs).toEqual([]);
  });
});

describe('getProfilesForArch', () => {
  it('returns ModelProfile CR objects joined on model_arch', () => {
    const profiles = getProfilesForArch('arch-a', modelProfiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].metadata.name).toBe('arch-a-profile');
    expect(profiles[0].spec.model_arch).toBe('arch-a');
  });

  it('returns an empty array for an arch with no profiles', () => {
    expect(getProfilesForArch('unmapped-arch', modelProfiles)).toEqual([]);
  });
});

// ─── parseBatchSizesInput ─────────────────────────────────────────────────────

describe('parseBatchSizesInput', () => {
  it('returns "*" for the all-batch-sizes wildcard', () => {
    expect(parseBatchSizesInput('*')).toBe('*');
    expect(parseBatchSizesInput('  *  ')).toBe('*');
  });

  it('parses a comma-separated list of batch sizes', () => {
    expect(parseBatchSizesInput('1, 2, 4')).toEqual([1, 2, 4]);
  });

  it('drops non-numeric entries', () => {
    expect(parseBatchSizesInput('1,,abc,4')).toEqual([1, 4]);
  });
});

// ─── crNameToDisplayName ──────────────────────────────────────────────────────

describe('crNameToDisplayName', () => {
  it('reverse-looks-up a crname to its display name', () => {
    expect(crNameToDisplayName(checkpointMapping, 'embed-model')).toBe('Embed-Model');
  });

  it('returns undefined for an unknown crname', () => {
    expect(crNameToDisplayName(checkpointMapping, 'does-not-exist')).toBeUndefined();
  });
});

// ─── readValidCondition ───────────────────────────────────────────────────────

describe('readValidCondition', () => {
  it('returns "pending" when there is no Valid condition', () => {
    expect(readValidCondition([])).toBe('pending');
    expect(readValidCondition([{ type: 'SomethingElse', status: 'True' }])).toBe('pending');
  });

  it('returns "succeeded" when the Valid condition status is True', () => {
    expect(readValidCondition([{ type: 'Valid', status: 'True' }])).toBe('succeeded');
  });

  it('returns "failed" when the Valid condition status is False', () => {
    expect(readValidCondition([{ type: 'Valid', status: 'False' }])).toBe('failed');
  });
});

// ─── buildModelDeploymentYaml ─────────────────────────────────────────────────

describe('buildModelDeploymentYaml', () => {
  it('emits a ModelDeployment referencing the bundle by name (Q6)', () => {
    const { yaml, deploymentName } = buildModelDeploymentYaml('my-bundle');
    expect(deploymentName).toBe('md-my-bundle');
    expect(yaml).toContain('kind: ModelDeployment');
    expect(yaml).toContain('name: md-my-bundle');
    expect(yaml).toContain('bundle: my-bundle');
  });

  it('carries over the same deployment knobs as the old BundleDeployment builder', () => {
    const { yaml } = buildModelDeploymentYaml('another-bundle');
    expect(yaml).toContain('groups:');
    expect(yaml).toContain('owner: no-reply@sambanova.ai');
    expect(yaml).toContain('secretNames:');
    expect(yaml).toContain('sambanova-artifact-reader');
    expect(yaml).toContain('engineConfig:');
    expect(yaml).toContain('startupTimeout: 7200');
  });
});

// ─── extractBundleName (parse-bundle-yaml.ts round-trip) ─────────────────────

describe('extractBundleName', () => {
  it('extracts the bundle name from a generated ModelBundle YAML', () => {
    const model = toModelCR('Llama-3-8B-Instruct', checkpointMapping['Llama-3-8B-Instruct']);
    const profile = toModelProfileCR('llama-3-8b-profile', modelProfiles['llama-3-8b-profile']);
    const selections: ModelBundleSelection[] = [{ model, arch: 'llama-3-8b', profile }];
    const yamlText = generateModelBundleYaml('my-test-bundle', selections);

    expect(extractBundleName(yamlText)).toBe('my-test-bundle');
  });

  it('returns an empty string for YAML that does not parse as a ModelBundle', () => {
    expect(extractBundleName('kind: NotABundle\nmetadata:\n  name: whatever\n')).toBe('');
    expect(extractBundleName('not: valid: yaml: [')).toBe('');
  });
});

// ─── End-to-end: CLI adapters feeding the shared V3 generator ───────────────

describe('CLI selections → generateModelBundleYaml (shared generator integration)', () => {
  it('emits a single-arch model ref, its effective batching config, and no specDecodingPairs', () => {
    const model = toModelCR('Llama-3-8B-Instruct', checkpointMapping['Llama-3-8B-Instruct']);
    const profile = toModelProfileCR('llama-3-8b-profile', modelProfiles['llama-3-8b-profile']);
    const selections: ModelBundleSelection[] = [{ model, arch: 'llama-3-8b', profile }];

    const yamlText = generateModelBundleYaml('single-arch-bundle', selections);

    expect(yamlText).toContain('kind: ModelBundle');
    // Single-arch model ref: <crname>:<version> (highest version = 2)
    expect(yamlText).toContain('model: llama-3-8b-instruct:2');
    expect(yamlText).toContain('profile: llama-3-8b-profile');
    expect(yamlText).not.toContain('specDecodingPairs');
  });

  it('emits a multi-arch model ref pinning the user-chosen arch', () => {
    const model = toModelCR('Multi-Arch-Model', checkpointMapping['Multi-Arch-Model']);
    const profile = toModelProfileCR('arch-a-profile', modelProfiles['arch-a-profile']);
    const selections: ModelBundleSelection[] = [{ model, arch: 'arch-a', profile }];

    const yamlText = generateModelBundleYaml('multi-arch-bundle', selections);

    expect(yamlText).toContain('model: multi-arch-model:arch-a:1');
  });

  it('marks the embedding model batching config is_default on its smallest tier', () => {
    const model = toModelCR('Embed-Model', checkpointMapping['Embed-Model']);
    const profile = toModelProfileCR('embed-profile', modelProfiles['embed-profile']);
    const selections: ModelBundleSelection[] = [{ model, arch: 'embed-arch', profile }];

    const yamlText = generateModelBundleYaml('embed-bundle', selections);

    expect(yamlText).toContain('is_default: true');
  });

  it('wires a draft model into specDecodingPairs with routable: false and bare crnames', () => {
    const targetModel = toModelCR('Llama-3-8B-Instruct', checkpointMapping['Llama-3-8B-Instruct']);
    const targetProfile = toModelProfileCR('sd-target-profile', {
      ...modelProfiles['sd-target-profile'],
      model_arch: 'llama-3-8b', // join back to the target model's arch for this test
    });
    const draftModel = toModelCR('Draft-Model', checkpointMapping['Draft-Model']);
    const draftProfile = toModelProfileCR('draft-profile', modelProfiles['draft-profile']);

    const selections: ModelBundleSelection[] = [
      { model: draftModel, arch: 'draft-arch', profile: draftProfile, isDraftFor: 'llama-3-8b-instruct' },
      { model: targetModel, arch: 'llama-3-8b', profile: targetProfile },
    ];

    const yamlText = generateModelBundleYaml('sd-bundle', selections);

    expect(yamlText).toContain('routable: false');
    expect(yamlText).toContain('specDecodingPairs');
    expect(yamlText).toContain('draft: draft-model');
    expect(yamlText).toContain('target: llama-3-8b-instruct');
  });
});

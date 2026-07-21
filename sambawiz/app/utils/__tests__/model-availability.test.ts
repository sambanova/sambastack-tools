import { getAvailableModels } from '../model-availability';
import type { CheckpointMappingV3, ModelProfilesCache, Model, ModelProfile } from '../../types/bundle';
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

/** Adapts a fixture `Model` into a `CheckpointMappingV3` entry, matching the
 * shape `generate-checkpoint-mapping/route.ts` writes. */
function toCheckpointEntry(model: Model): CheckpointMappingV3[string] {
  return {
    resource_name: model.metadata.name,
    checkpoints: model.spec.checkpoints,
    capabilities: model.spec.metadata.capabilities,
  };
}

/** Adapts a fixture `ModelProfile` into a `ModelProfilesCache` entry, matching
 * the shape `generate-model-profiles/route.ts` writes. */
function toProfileEntry(profile: ModelProfile): ModelProfilesCache[string] {
  return {
    model_arch: profile.spec.model_arch,
    features: profile.spec.features,
    batchingConfig: profile.spec.defaultBatchingConfig ?? profile.status?.batchingConfig ?? {},
    pefs: profile.spec.pefs,
  };
}

describe('getAvailableModels', () => {
  it('marks a model available when its single arch has a matching profile', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingTargetModel.spec.name]: toCheckpointEntry(mockSpecDecodingTargetModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingTargetProfile.metadata.name]: toProfileEntry(mockSpecDecodingTargetProfile),
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.excludedModelNames).toEqual([]);
    expect(result.available).toHaveLength(1);
    expect(result.available[0]).toMatchObject({
      displayName: mockSpecDecodingTargetModel.spec.name,
      resourceName: mockSpecDecodingTargetModel.metadata.name,
      isEmbedding: false,
    });
    expect(result.available[0].archs).toHaveLength(1);
    expect(result.available[0].archs[0].arch).toBe('llama-3p3-70b');
    expect(result.available[0].archs[0].matchingProfiles.map((p) => p.metadata.name)).toEqual([
      mockSpecDecodingTargetProfile.metadata.name,
    ]);
  });

  it('excludes a model with no matching profile on any arch (Q4 no-profile guard)', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSingleArchModel.spec.name]: toCheckpointEntry(mockSingleArchModel),
    };
    // No profile has model_arch === 'e5-mistral'.
    const modelProfiles: ModelProfilesCache = {
      [mockContinuousBatchingProfile.metadata.name]: toProfileEntry(mockContinuousBatchingProfile),
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.available).toEqual([]);
    expect(result.excludedModelNames).toEqual([mockSingleArchModel.spec.name]);
  });

  it('handles a multi-arch model where only one arch has a matching profile', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockMultiArchModel.spec.name]: toCheckpointEntry(mockMultiArchModel),
    };
    const modelProfiles: ModelProfilesCache = {
      // Fabricate a profile matching only the second arch of the multi-arch model.
      'maverick-v2-profile': {
        model_arch: 'llama-4-maverick-v2',
        features: [],
        batchingConfig: { '8k': { batch_sizes: [1] } },
        pefs: ['llama-4-maverick-v2-ss8192-bs1:1'],
      },
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.excludedModelNames).toEqual([]);
    expect(result.available).toHaveLength(1);
    // Only the matching arch should be included, not the non-matching one.
    expect(result.available[0].archs).toHaveLength(1);
    expect(result.available[0].archs[0].arch).toBe('llama-4-maverick-v2');
  });

  it('flags embedding models via isEmbeddingModel (Q10: capabilities includes "embeddings")', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel),
    };
    const modelProfiles: ModelProfilesCache = {
      'gte-qwen2-profile': {
        model_arch: 'gte-qwen2',
        features: [],
        batchingConfig: {},
        pefs: [],
      },
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.available).toHaveLength(1);
    expect(result.available[0].isEmbedding).toBe(true);
  });

  it('does not flag a non-embedding model as embedding', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.available[0].isEmbedding).toBe(false);
  });

  it('joins multiple profiles onto the same arch (returns all matching profiles)', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingTargetModel.spec.name]: toCheckpointEntry(mockSpecDecodingTargetModel),
    };
    const secondProfile: ModelProfile = {
      ...mockSpecDecodingTargetProfile,
      metadata: { name: 'llama-3p1-70b-hi' },
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingTargetProfile.metadata.name]: toProfileEntry(mockSpecDecodingTargetProfile),
      [secondProfile.metadata.name]: toProfileEntry(secondProfile),
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.available[0].archs[0].matchingProfiles).toHaveLength(2);
    const names = result.available[0].archs[0].matchingProfiles.map((p) => p.metadata.name).sort();
    expect(names).toEqual(['llama-3p1-70b-hi', 'llama-3p1-70b-sd'].sort());
  });

  it('handles a full mixed cache: some models available, some excluded, sorted output', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSingleArchModel.spec.name]: toCheckpointEntry(mockSingleArchModel), // no matching profile -> excluded
      [mockMultiArchModel.spec.name]: toCheckpointEntry(mockMultiArchModel), // no matching profile -> excluded
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel), // no matching profile -> excluded
      [mockSpecDecodingTargetModel.spec.name]: toCheckpointEntry(mockSpecDecodingTargetModel), // matches
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel), // matches
    };
    const modelProfiles: ModelProfilesCache = {
      [mockContinuousBatchingProfile.metadata.name]: toProfileEntry(mockContinuousBatchingProfile),
      [mockHighInteractivityProfile.metadata.name]: toProfileEntry(mockHighInteractivityProfile),
      [mockSpecDecodingTargetProfile.metadata.name]: toProfileEntry(mockSpecDecodingTargetProfile),
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.available.map((m) => m.displayName)).toEqual(
      [mockSpecDecodingDraftModel.spec.name, mockSpecDecodingTargetModel.spec.name].sort((a, b) =>
        a.localeCompare(b)
      )
    );
    expect(result.excludedModelNames).toEqual(
      [mockSingleArchModel.spec.name, mockMultiArchModel.spec.name, mockEmbeddingModel.spec.name].sort((a, b) =>
        a.localeCompare(b)
      )
    );
  });

  it('returns empty available/excluded for empty inputs', () => {
    const result = getAvailableModels({}, {});
    expect(result.available).toEqual([]);
    expect(result.excludedModelNames).toEqual([]);
  });

  it('excludes a model whose checkpoints map has no archs at all', () => {
    const checkpointMapping: CheckpointMappingV3 = {
      'Empty-Model': {
        resource_name: 'empty-model',
        checkpoints: {},
        capabilities: [],
      },
    };
    const modelProfiles: ModelProfilesCache = {
      'some-profile': { model_arch: 'some-arch', features: [], batchingConfig: {}, pefs: [] },
    };

    const result = getAvailableModels(checkpointMapping, modelProfiles);

    expect(result.available).toEqual([]);
    expect(result.excludedModelNames).toEqual(['Empty-Model']);
  });
});

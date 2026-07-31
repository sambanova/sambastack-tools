import type {
  Model,
  ModelProfile,
  ModelBundle,
} from '../../types/bundle';

/**
 * V3 mock fixtures (Model / ModelProfile / ModelBundle), matching the worked
 * examples in v3plan.md. Published as part of Phase 0 (F0.2) so UI/CLI/test
 * threads can build and test against realistic V3 shapes before the real
 * generator/parser/data-layer land.
 */

// ----------------------------------------------------------------------------
// Models
// ----------------------------------------------------------------------------

/** Single-arch text model. */
export const mockSingleArchModel: Model = {
  metadata: {
    name: 'e5-mistral-7b-instruct',
  },
  spec: {
    name: 'E5-Mistral-7B-Instruct',
    checkpoints: {
      'e5-mistral': {
        versions: {
          '1': {
            checkpoint_status: 'stable',
            source: 'gs://sambanova-checkpoints/e5-mistral-7b-instruct/v1',
            tool_support: false,
          },
        },
      },
    },
    metadata: {
      architecture: 'Mistral',
      capabilities: ['embeddings'],
      category: 'embedding',
      provider: 'Intfloat',
      license: 'MIT',
    },
  },
};

/**
 * Multi-arch model (2 archs, one 'stable' + one 'preview'), mirroring the
 * plan's llama-4-maverick example verbatim.
 */
export const mockMultiArchModel: Model = {
  metadata: {
    name: 'llama-4-maverick-17b-128e-instruct',
  },
  spec: {
    name: 'Llama-4-Maverick-17B-128E-Instruct',
    aliases: ['llama-4-maverick', 'Llama 4 Maverick 17B 128E Instruct'],
    checkpoints: {
      'llama-4-maverick': {
        versions: {
          '1': {
            checkpoint_status: 'stable',
            source: 'gs://sambanova-checkpoints/llama-4-maverick/v1',
            tool_support: true,
            vision_embedding_checkpoint:
              'gs://sambanova-checkpoints/llama-4-maverick/v1-vision',
          },
        },
      },
      'llama-4-maverick-v2': {
        versions: {
          '1': {
            checkpoint_status: 'preview',
            source: 'gs://sambanova-checkpoints/llama-4-maverick-v2/v1',
            tool_support: true,
            vision_embedding_checkpoint:
              'gs://sambanova-checkpoints/llama-4-maverick-v2/v1-vision',
          },
        },
      },
    },
    metadata: {
      architecture: 'Llama 4',
      capabilities: ['text', 'vision'],
      category: 'chat',
      provider: 'Meta',
      license: 'llama4',
    },
  },
};

/** Embedding model (capabilities includes "embeddings"). */
export const mockEmbeddingModel: Model = {
  metadata: {
    name: 'gte-qwen2-7b-instruct',
  },
  spec: {
    name: 'GTE-Qwen2-7B-Instruct',
    checkpoints: {
      'gte-qwen2': {
        versions: {
          '1': {
            checkpoint_status: 'stable',
            source: 'gs://sambanova-checkpoints/gte-qwen2-7b-instruct/v1',
            tool_support: false,
          },
        },
      },
    },
    metadata: {
      architecture: 'Qwen2',
      capabilities: ['embeddings'],
      category: 'embedding',
      provider: 'Alibaba',
      license: 'apache-2.0',
    },
  },
};

/** Spec-decoding target model (70B), from the plan's worked example. */
export const mockSpecDecodingTargetModel: Model = {
  metadata: {
    name: 'meta-llama-3-3-70b-instruct',
  },
  spec: {
    name: 'Meta-Llama-3.3-70B-Instruct',
    checkpoints: {
      'llama-3p3-70b': {
        versions: {
          '1': {
            checkpoint_status: 'stable',
            source: 'gs://sambanova-checkpoints/meta-llama-3-3-70b-instruct/v1',
            tool_support: true,
          },
        },
      },
    },
    metadata: {
      architecture: 'Llama 3.3',
      capabilities: ['text'],
      category: 'chat',
      provider: 'Meta',
      license: 'llama3.3',
    },
  },
};

/** Spec-decoding draft model (1B), from the plan's worked example. */
export const mockSpecDecodingDraftModel: Model = {
  metadata: {
    name: 'meta-llama-3-2-1b-instruct',
  },
  spec: {
    name: 'Meta-Llama-3.2-1B-Instruct',
    checkpoints: {
      'llama-3p2-1b': {
        versions: {
          '1': {
            checkpoint_status: 'stable',
            source: 'gs://sambanova-checkpoints/meta-llama-3-2-1b-instruct/v1',
            tool_support: false,
          },
        },
      },
    },
    metadata: {
      architecture: 'Llama 3.2',
      capabilities: ['text'],
      category: 'chat',
      provider: 'Meta',
      license: 'llama3.2',
    },
  },
};

export const mockModels: Model[] = [
  mockSingleArchModel,
  mockMultiArchModel,
  mockEmbeddingModel,
  mockSpecDecodingTargetModel,
  mockSpecDecodingDraftModel,
];

// ----------------------------------------------------------------------------
// ModelProfiles
// ----------------------------------------------------------------------------

/**
 * `features: [continuous_batching]` -> "High Throughput". Based closely on
 * the plan's `deepseek-cb` example.
 */
export const mockContinuousBatchingProfile: ModelProfile = {
  metadata: {
    name: 'deepseek-cb',
  },
  spec: {
    model_arch: 'deepseek',
    features: ['continuous_batching'],
    defaultBatchingConfig: {
      '8k': { batch_sizes: [1] },
      '32k': { batch_sizes: [1] },
    },
    pefs: ['deepseek-ss32768-bs1-cb2-64:1'],
    secretNames: ['sambanova-artifact-reader'],
  },
  status: {
    batchingConfig: {
      '8k': { batch_sizes: [1] },
      '32k': { batch_sizes: [1] },
    },
  },
};

/**
 * Empty `features` -> "High Interactivity". Based closely on the plan's
 * `gpt-oss-fp8-dyt` example.
 */
export const mockHighInteractivityProfile: ModelProfile = {
  metadata: {
    name: 'gpt-oss-fp8-dyt',
  },
  spec: {
    model_arch: 'gpt-oss-fp8',
    features: [],
    defaultBatchingConfig: {
      '8k': { batch_sizes: [2, 4, 6, 8] },
      '32k': { batch_sizes: [2, 4, 6, 8] },
      '64k': { batch_sizes: [2, 4] },
      '128k': { batch_sizes: [2] },
    },
    pefs: ['gpt-oss-fp8-ss131072-bs8-dyt-1:1'],
    secretNames: ['sambanova-artifact-reader'],
  },
};

/**
 * Spec-decoding profile for the 70B target — `pefs` contains a name with
 * "sd" in it, which surfaces the draft-model dropdown.
 */
export const mockSpecDecodingTargetProfile: ModelProfile = {
  metadata: {
    name: 'llama-3p1-70b-sd',
  },
  spec: {
    model_arch: 'llama-3p3-70b',
    features: [],
    defaultBatchingConfig: {
      '4k': { batch_sizes: [1, 4] },
      '16k': { batch_sizes: [1] },
    },
    pefs: ['llama-3p1-70b-ss4096-bs4-sd-1:1'],
    secretNames: ['sambanova-artifact-reader'],
  },
  status: {
    batchingConfig: {
      '4k': { batch_sizes: [1, 4] },
      '16k': { batch_sizes: [1] },
    },
  },
};

/** Corresponding draft profile for the 1B model. */
export const mockSpecDecodingDraftProfile: ModelProfile = {
  metadata: {
    name: 'llama-3p1-1b',
  },
  spec: {
    model_arch: 'llama-3p2-1b',
    features: [],
    defaultBatchingConfig: {
      '4k': { batch_sizes: [1, 4] },
      '16k': { batch_sizes: [1] },
    },
    pefs: ['llama-3p1-1b-ss4096-bs4-1:1'],
    secretNames: ['sambanova-artifact-reader'],
  },
};

export const mockModelProfiles: ModelProfile[] = [
  mockContinuousBatchingProfile,
  mockHighInteractivityProfile,
  mockSpecDecodingTargetProfile,
  mockSpecDecodingDraftProfile,
];

// ----------------------------------------------------------------------------
// ModelBundle — worked spec-decoding example (target=70B, draft=1B)
// ----------------------------------------------------------------------------

/**
 * Matches the plan's "Worked spec-decoding example": target 70B (profile
 * with sd PEFs) + draft 1B (routable: false), specDecodingPairs using bare
 * crnames, no `experts` field.
 */
export const mockSpecDecodingModelBundle: ModelBundle = {
  metadata: {
    name: '70b-3dot3-ss-4-8-16-32-64-128k',
  },
  spec: {
    modelConfigs: [
      {
        model: 'meta-llama-3-2-1b-instruct:1',
        profile: 'llama-3p1-1b',
        modelSettings: {
          routable: false,
        },
        batchingConfig: {
          '4k': { batch_sizes: [1, 4] },
          '16k': { batch_sizes: [1] },
        },
      },
      {
        model: 'meta-llama-3-3-70b-instruct:1',
        profile: 'llama-3p1-70b-sd',
        batchingConfig: {
          '4k': { batch_sizes: [1, 4] },
          '16k': { batch_sizes: [1] },
        },
      },
    ],
    specDecodingPairs: [
      {
        draft: 'meta-llama-3-2-1b-instruct',
        target: 'meta-llama-3-3-70b-instruct',
      },
    ],
  },
  status: {
    conditions: [
      {
        type: 'Valid',
        status: 'True',
        reason: 'Legalized',
        message: 'Bundle legalized successfully',
      },
    ],
    legalizerInfo: {
      status: 'Success',
      errors: [],
      warnings: [],
      utilization: {
        ddr: 0.42,
        hbm_resident: 0.61,
        host: 0.15,
      },
    },
  },
};

export const mockModelBundles: ModelBundle[] = [mockSpecDecodingModelBundle];

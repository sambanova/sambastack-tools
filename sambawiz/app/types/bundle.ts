export interface PefConfig {
  ss: string;
  bs: string;
  latestVersion: string;
}

export interface PefConfigs {
  [pefName: string]: PefConfig | PefConfig[];
}

export interface CheckpointMapping {
  [modelName: string]: {
    path: string;
    resource_name: string;
    vision_embedding_checkpoint?: string;
    model_type?: string;
  };
}

export interface ConfigSelection {
  modelName: string;
  ss: string;
  bs: string;
  pefName: string;
}

// ============================================================================
// V3 types (ModelProfile / ModelBundle / ModelDeployment / Model)
//
// These types are the frozen contract for the V3 migration (see v3plan.md).
// Do NOT remove or change existing V2 types above — only add here. Other
// threads (generator/parser rewrite, UI, CLI) build directly against these
// shapes, so field names/nesting must match the plan's worked examples.
// ============================================================================

/**
 * The `Model` CR — the source of checkpoints, joined to a `ModelProfile` via
 * `spec.checkpoints.<arch>` (the arch key === `ModelProfile.spec.model_arch`).
 *
 * `metadata.name` is the crname used in `modelConfigs[].model` refs;
 * `spec.name` is the display name shown to the user in the selection UI.
 */
export interface Model {
  metadata: {
    name: string; // crname, e.g. "llama-4-maverick-17b-128e-instruct"
  };
  spec: {
    name: string; // display name, e.g. "Llama-4-Maverick-17B-128E-Instruct"
    aliases?: string[];
    /** Keyed by arch (join key to ModelProfile.spec.model_arch). */
    checkpoints: {
      [arch: string]: {
        versions: {
          [version: string]: {
            checkpoint_status?: string; // e.g. "stable" | "preview"
            source: string; // e.g. gs:// path
            tool_support?: boolean;
            vision_embedding_checkpoint?: string;
          };
        };
      };
    };
    metadata: {
      architecture?: string;
      capabilities: string[]; // e.g. ["text", "vision"] or ["embeddings"]
      category?: string;
      provider?: string;
      license?: string;
      [key: string]: unknown;
    };
  };
}

/**
 * Declarative batching config, keyed by expert/sequence-length tier.
 * Tier keys look like `8k`, `32k`, `128k`, a bare int like `448` (sub-1k
 * PEFs), or `<n>t` (codes-length keys for vocoder PEFs, e.g. `10t`).
 *
 * Used both as `ModelProfile.spec.defaultBatchingConfig` /
 * `ModelProfile.status.batchingConfig` and as the per-bundle override
 * `ModelBundle.spec.modelConfigs[].batchingConfig`.
 */
export interface BatchingConfig {
  [tier: string]: {
    batch_sizes: number[] | '*';
    /** Auto-derived: true only on the smallest tier, for embedding models. */
    is_default?: boolean;
  };
}

/**
 * The `ModelProfile` CR — replaces `BundleTemplate`, scoped to a single model.
 * `metadata.name` is never shown in the UI; the display title is derived
 * from `spec.features` (see `GetDisplayNameFn`).
 */
export interface ModelProfile {
  metadata: {
    name: string;
  };
  spec: {
    model_arch: string; // join key to Model.spec.checkpoints.<arch>
    features: string[]; // e.g. ["continuous_batching"]; [] => "High Interactivity"
    defaultBatchingConfig?: BatchingConfig;
    pefs: string[]; // <pef-cr-name>:<version> refs; name containing "sd" => spec-decoding profile
    secretNames?: string[];
  };
  status?: {
    batchingConfig?: BatchingConfig; // resolved default, published for visibility only
  };
}

/**
 * `ModelBundle.spec.specDecodingPairs[]` entry. `experts` is always omitted
 * by the SambaWiz builder (spec decoding applies to all target experts), but
 * the type still allows it since the CR itself supports it.
 */
export interface SpecDecodingPair {
  target: string; // bare Model crname, no :arch/:version
  draft: string; // bare Model crname, no :arch/:version
  experts?: string[];
}

/**
 * One entry in `ModelBundle.spec.modelConfigs[]` — one per selected model.
 * Exactly one of `profile` / `profileDefinition` is set at runtime (the
 * SambaWiz builder only ever emits `profile`, a named reference); both are
 * optional here since it's a union by convention, not structurally enforced.
 */
export interface ModelConfigEntry {
  model: string; // <crname>[:<arch>][:<version>] — see ModelRefFormatFn
  profile?: string; // named ModelProfile reference (what the builder emits)
  profileDefinition?: unknown; // inline ModelProfileSpec (builder never emits this)
  batchingConfig?: BatchingConfig; // always emitted in full by the builder (Q1)
  modelSettings?: {
    properties?: Record<string, unknown>;
    swappable?: boolean;
    routable?: boolean; // builder only ever sets `false`, on spec-decoding drafts
    adapters?: unknown;
    checkpointOverrides?: unknown;
  };
}

/**
 * Status shape shared verbatim with the V2 `Bundle` status (confirmed live
 * against a real ModelBundle in the plan, Q5) — `extractValidationStatus`
 * works as-is once the resource kind switches to `ModelBundle`.
 */
export interface ModelBundleStatus {
  conditions: Array<{
    type: string;
    status: string;
    reason: string;
    message: string;
  }>;
  legalizerInfo: {
    status: string;
    errors: string[];
    warnings: string[];
    utilization: {
      ddr: number;
      hbm_resident: number;
      host: number;
    };
  };
}

/**
 * The `ModelBundle` CR — replaces `Bundle`, combines multiple `ModelProfile`s
 * (via `modelConfigs[]`) plus optional spec-decoding wiring. SambaWiz emits
 * exactly one of these per bundle (no `secretNames` — profiles carry them,
 * Q7).
 */
export interface ModelBundle {
  metadata: {
    name: string;
  };
  spec: {
    modelConfigs: ModelConfigEntry[];
    specDecodingPairs?: SpecDecodingPair[];
    adapters?: unknown;
    skip_legalizer?: boolean;
  };
  status?: ModelBundleStatus;
}

/**
 * The `ModelDeployment` CR — replaces `BundleDeployment`. SambaWiz always
 * emits `spec.bundle` (a named ModelBundle reference), never inline
 * `spec.models` (Q6); the inline form is included in the type for
 * round-trip/manual-edit compatibility only.
 */
export interface ModelDeployment {
  metadata: {
    name: string;
  };
  spec: {
    bundle?: string; // named ModelBundle reference (what the builder emits)
    models?: unknown; // inline ModelBundleSpec (builder never emits this)
    groups?: unknown;
    owner?: string;
    storage?: unknown;
    storageClass?: string;
    secretNames?: string[];
    nodeSelector?: Record<string, unknown>;
    tolerations?: unknown[];
    cacheConfig?: unknown;
    engineConfig?: unknown;
    tokenizerConfig?: unknown;
  };
}

// ----------------------------------------------------------------------------
// Multi-arch cache types (V3). These are additive/new — the existing
// single-arch `CheckpointMapping` above is untouched and still used by V2
// code (BundleForm.tsx, model-availability.ts, the old generator/parser).
// ----------------------------------------------------------------------------

/**
 * Multi-arch replacement for `CheckpointMapping`, keyed by `Model.spec.name`
 * (display name). Mirrors the full `Model.spec.checkpoints` shape (all
 * archs + versions), plus `capabilities` for embedding detection (Q10).
 */
export interface CheckpointMappingV3 {
  [displayName: string]: {
    resource_name: string; // crname, Model.metadata.name
    checkpoints: {
      [arch: string]: {
        versions: {
          [version: string]: {
            checkpoint_status?: string;
            source: string;
            tool_support?: boolean;
            vision_embedding_checkpoint?: string;
          };
        };
      };
    };
    capabilities: string[]; // for embedding detection: includes "embeddings"
  };
}

/**
 * New cache of `ModelProfile` CRs, keyed by `metadata.name`. `batchingConfig`
 * here is whichever of `spec.defaultBatchingConfig` / `status.batchingConfig`
 * was resolved when the cache was built.
 */
export interface ModelProfilesCache {
  [profileName: string]: {
    model_arch: string;
    features: string[];
    batchingConfig: BatchingConfig;
    pefs: string[];
  };
}

// ----------------------------------------------------------------------------
// Frozen signatures (F0.2) — documenting the contract other threads build
// against. No implementations here; these are types only.
// ----------------------------------------------------------------------------

/**
 * Derives a profile card's display title from its features, never
 * `metadata.name`: `features` includes `continuous_batching` => "High
 * Throughput", else "High Interactivity". When more than one profile of the
 * same type is shown for a model, number them in listing order ("High
 * Interactivity 1", "High Interactivity 2", ...); a lone profile of a type is
 * left unnumbered.
 */
export type GetDisplayNameFn = (
  profile: ModelProfile,
  siblingProfiles: ModelProfile[],
  indexAmongSameType: number
) => string;

/**
 * A model is treated as an embedding model when its `Model.spec.metadata.
 * capabilities` list contains `"embeddings"` (Q10) — drives `is_default`
 * placement on the smallest batching tier.
 */
export type IsEmbeddingModelFn = (model: Model) => boolean;

/**
 * A `ModelProfile` is a speculative-decoding profile when any entry in
 * `spec.pefs` contains `"sd"` in its name — surfaces the draft-model
 * dropdown when true.
 */
export type IsSpecDecodingProfileFn = (profile: ModelProfile) => boolean;

/**
 * Formats a `modelConfigs[].model` ref: `<crname>:<version>` for single-arch
 * models, `<crname>:<arch>:<version>` for multi-arch models (arch pinned via
 * the Step-2 dropdown). Version is always the highest checkpoint version
 * under the chosen arch (Q11).
 */
export type FormatModelRefFn = (
  crname: string,
  version: string,
  arch?: string
) => string;

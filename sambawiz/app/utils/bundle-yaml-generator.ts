import yaml from 'js-yaml';
import type {
  Model,
  ModelProfile,
  ModelBundle,
  ModelConfigEntry,
  SpecDecodingPair,
  BatchingConfig,
} from '../types/bundle';

/**
 * V3 `ModelBundle` generator — framework-agnostic (no React/MUI imports) so
 * it can be shared by the Model Selection UI and the CLI (see v3plan.md,
 * "Parallel execution plan", Thread B).
 *
 * Replaces the old V2 generator, which hand-built a `BundleTemplate\n---\n
 * Bundle` string via template literals. This generator instead builds a
 * plain-object `ModelBundle` document and serializes it with `js-yaml`.
 */

/**
 * One "model selection" going into the bundle — one per `modelConfigs[]`
 * entry. `arch` is the checkpoint arch pinned in Step 2 of the builder (the
 * only arch, for single-arch models; the user-picked arch, for multi-arch
 * models). `batchingConfigOverride`, if present, is the Step-3 bundle-level
 * override; otherwise the profile's own effective default is used.
 * `isDraftFor`, when set, is the *target* model's crname, marking this
 * selection as a spec-decoding draft. `swappable` is the Step-3 Advanced
 * Options toggle; it defaults to `true` and is only emitted (as
 * `modelSettings.swappable: false`) when the user explicitly turns it off.
 */
export interface ModelBundleSelection {
  model: Model;
  arch: string;
  profile: ModelProfile;
  batchingConfigOverride?: BatchingConfig;
  isDraftFor?: string;
  swappable?: boolean;
  /**
   * Checkpoint version pin from app-config.json `checkpoint_overrides`
   * (keyed by model display name). When set, the model ref uses this version
   * instead of the model's latest checkpoint version.
   */
  versionOverride?: string;
}

/**
 * Parses a batching-config tier key (`8k`, `32k`, `448`, `10t`) into a
 * comparable number, so tiers can be ordered by sequence length (e.g. the
 * smallest tier can be found, or the UI can list them descending). Adapted
 * from the old V2 `parseExpertKey`, extended to accept the `t` (codes-length)
 * suffix mentioned in v3plan.md alongside the `k` suffix.
 */
export function parseTierKey(key: string): number {
  const match = key.match(/^(\d+(?:\.\d+)?)([kt])?$/i);
  if (!match) {
    return parseFloat(key);
  }
  const value = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') {
    return value * 1024;
  }
  return value;
}

/**
 * Finds the highest checkpoint version under a `Model`'s given arch (Q11 —
 * always pin the latest version). Versions are numeric strings ("1", "2",
 * "10"), so comparison is numeric, not lexicographic.
 */
export function getHighestVersion(model: Model, arch: string): string {
  const archData = model.spec.checkpoints[arch];
  if (!archData) {
    throw new Error(`Model "${model.metadata.name}" has no checkpoint arch "${arch}"`);
  }
  const versions = Object.keys(archData.versions);
  if (versions.length === 0) {
    throw new Error(`Model "${model.metadata.name}" arch "${arch}" has no checkpoint versions`);
  }
  return versions.reduce((highest, current) => (Number(current) > Number(highest) ? current : highest));
}

/**
 * Formats a `modelConfigs[].model` ref per the plan's Model-ref format:
 * `<crname>:<version>` when the Model CR has exactly one checkpoint arch,
 * else `<crname>:<arch>:<version>` (arch pinned via the Step-2 dropdown).
 */
export function formatModelRef(model: Model, arch: string, versionOverride?: string): string {
  const version = versionOverride ?? getHighestVersion(model, arch);
  const archCount = Object.keys(model.spec.checkpoints).length;
  return archCount === 1
    ? `${model.metadata.name}:${version}`
    : `${model.metadata.name}:${arch}:${version}`;
}

/**
 * Formats a `modelConfigs[].model` ref for the single-model quick-deploy path,
 * WITHOUT pinning a checkpoint version — SambaWiz always deploys the latest, and
 * the operator resolves the highest version when the ref omits it (see
 * `validate_checkpoint_ref` in fast-coe). Arch is included only for multi-arch
 * Model CRs, since the operator resolves the checkpoint arch from the ref alone
 * (independently of the chosen profile) and errors on an omitted arch when the
 * model has more than one: `<crname>` for single-arch, `<crname>:<arch>` otherwise.
 */
export function formatModelRefLatest(model: Model, arch: string, versionOverride?: string): string {
  const archCount = Object.keys(model.spec.checkpoints).length;
  const base = archCount === 1 ? model.metadata.name : `${model.metadata.name}:${arch}`;
  // With an explicit version override, pin that version; otherwise omit it so
  // the operator resolves the latest checkpoint version at deploy time.
  return versionOverride ? `${base}:${versionOverride}` : base;
}

/**
 * A model is an embedding model when its `spec.metadata.capabilities`
 * includes `"embeddings"` (Q10).
 */
export function isEmbeddingModel(model: Model): boolean {
  return model.spec.metadata.capabilities?.includes('embeddings') ?? false;
}

/**
 * A profile's effective batching config: its own declarative default, else
 * the operator-published resolved default, else empty (per `batching.py`'s
 * priority — the live-generated fallback isn't something SambaWiz computes).
 */
export function getEffectiveBatchingConfig(profile: ModelProfile): BatchingConfig {
  return profile.spec.defaultBatchingConfig ?? profile.status?.batchingConfig ?? {};
}

/**
 * Drops any tier whose `batch_sizes` is an empty array (all batch sizes were
 * unchecked in the Step-3 override): a tier with no selected batch sizes is
 * omitted from the emitted config entirely rather than serialized as
 * `batch_sizes: []`. The `'*'` sentinel is never empty, so it's preserved.
 */
export function dropEmptyTiers(batchingConfig: BatchingConfig): BatchingConfig {
  const result: BatchingConfig = {};
  for (const [tier, cfg] of Object.entries(batchingConfig)) {
    if (Array.isArray(cfg.batch_sizes) && cfg.batch_sizes.length === 0) continue;
    result[tier] = cfg;
  }
  return result;
}

/**
 * Normalizes a tier's `batch_sizes` to a comparison key: the `'*'` sentinel as
 * itself, else a sorted, comma-joined list (so element order never affects
 * equality).
 */
function batchSizesKey(batchSizes: number[] | '*'): string {
  return batchSizes === '*' ? '*' : [...batchSizes].sort((a, b) => a - b).join(',');
}

/**
 * Returns a copy of `batchingConfig` with each tier's `batch_sizes` collapsed
 * to the `'*'` sentinel when it exactly matches that same tier's batch sizes in
 * `profileDefault` (order-independent, via `batchSizesKey`). This is a
 * YAML-shrinking convenience only: `'*'` means "the profile default's batch
 * sizes for this tier", so emitting it instead of the explicit list keeps the
 * document compact when a tier was left at its default while sibling tiers were
 * overridden. `is_default` (and any other tier field) is preserved. Tiers with
 * no matching default, or already `'*'`, are passed through unchanged.
 */
export function collapseTiersToWildcard(
  batchingConfig: BatchingConfig,
  profileDefault: BatchingConfig
): BatchingConfig {
  const result: BatchingConfig = {};
  for (const [tier, cfg] of Object.entries(batchingConfig)) {
    const def = profileDefault[tier];
    const matchesDefault = def !== undefined && batchSizesKey(cfg.batch_sizes) === batchSizesKey(def.batch_sizes);
    result[tier] = matchesDefault ? { ...cfg, batch_sizes: '*' } : cfg;
  }
  return result;
}

/**
 * Returns a copy of `batchingConfig` with each tier's `'*'` sentinel expanded to
 * that same tier's batch sizes in `profileDefault`. `'*'` means "the profile
 * default's batch sizes for this tier", so this makes a wildcard tier directly
 * comparable to the explicit default — used to decide whether an override is
 * really just the default (and can be omitted from the YAML). Tiers that aren't
 * `'*'`, or that have no matching default, are passed through unchanged. This is
 * the inverse of `collapseTiersToWildcard`.
 */
export function resolveWildcardTiers(
  batchingConfig: BatchingConfig,
  profileDefault: BatchingConfig
): BatchingConfig {
  const result: BatchingConfig = {};
  for (const [tier, cfg] of Object.entries(batchingConfig)) {
    const def = profileDefault[tier];
    result[tier] =
      cfg.batch_sizes === '*' && def !== undefined ? { ...cfg, batch_sizes: def.batch_sizes } : cfg;
  }
  return result;
}

/**
 * Deep, order-independent equality for two batching configs: same set of tiers,
 * and for each tier the same batch sizes and the same `is_default` flag.
 */
export function batchingConfigsEqual(a: BatchingConfig, b: BatchingConfig): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const ac = a[key];
    const bc = b[key];
    if (!bc) return false;
    if (batchSizesKey(ac.batch_sizes) !== batchSizesKey(bc.batch_sizes)) return false;
    if (Boolean(ac.is_default) !== Boolean(bc.is_default)) return false;
  }
  return true;
}

/**
 * Returns a copy of `batchingConfig` with its tiers reinserted in descending
 * sequence-length order (e.g. 192k, 128k, 64k, 32k, 8k), so the emitted YAML
 * lists longest-context experts first. Object key insertion order drives the
 * `js-yaml` output order (dumped with `sortKeys` off).
 */
export function orderBatchingConfigDescending(batchingConfig: BatchingConfig): BatchingConfig {
  const ordered: BatchingConfig = {};
  Object.keys(batchingConfig)
    .sort((a, b) => parseTierKey(b) - parseTierKey(a))
    .forEach((key) => {
      ordered[key] = batchingConfig[key];
    });
  return ordered;
}

/**
 * Returns a copy of `batchingConfig` with `is_default` stripped from every
 * tier, then re-applied to exactly the smallest tier — but only when
 * `isEmbedding` is true (Q2). Non-embedding models never get `is_default` set.
 */
export function deriveIsDefaultTier(batchingConfig: BatchingConfig, isEmbedding: boolean): BatchingConfig {
  const tierKeys = Object.keys(batchingConfig);
  const result: BatchingConfig = {};

  for (const key of tierKeys) {
    result[key] = { batch_sizes: batchingConfig[key].batch_sizes };
  }

  if (isEmbedding && tierKeys.length > 0) {
    const smallestKey = tierKeys.reduce((min, key) => (parseTierKey(key) < parseTierKey(min) ? key : min));
    result[smallestKey] = { ...result[smallestKey], is_default: true };
  }

  return result;
}

type ProfileDisplayType = 'High Throughput' | 'High Interactivity';

function resolveProfileType(profile: ModelProfile): ProfileDisplayType {
  return profile.spec.features?.includes('continuous_batching') ? 'High Throughput' : 'High Interactivity';
}

/**
 * Derives a profile card's display title from `spec.features`, never
 * `metadata.name`: `continuous_batching` => "High Throughput", else "High
 * Interactivity". When more than one profile of the same resulting type is
 * present in `allProfilesForSameModel`, they're numbered in listing order
 * ("High Interactivity 1", "High Interactivity 2", ...); a lone profile of a
 * type is left unnumbered.
 *
 * This is UI-facing (no UI consumes it yet), but lives in the shared module
 * per Thread B's scope so the future UI thread and the CLI can both use it.
 */
export function getDisplayName(profile: ModelProfile, allProfilesForSameModel: ModelProfile[]): string {
  const type = resolveProfileType(profile);
  const sameType = allProfilesForSameModel.filter((candidate) => resolveProfileType(candidate) === type);

  if (sameType.length <= 1) {
    return type;
  }

  const index = sameType.findIndex(
    (candidate) => candidate === profile || candidate.metadata.name === profile.metadata.name
  );
  const number = index === -1 ? sameType.length : index + 1;
  return `${type} ${number}`;
}

/**
 * A profile is a spec-decoding profile when any of its `spec.pefs` entries
 * has a name (the part before `:version`) containing `"sd"` as a substring.
 */
export function isSpecDecodingProfile(profile: ModelProfile): boolean {
  return profile.spec.pefs.some((ref) => {
    const name = ref.includes(':') ? ref.slice(0, ref.lastIndexOf(':')) : ref;
    return name.includes('sd');
  });
}

/**
 * Builds the `ModelBundle` object (metadata + spec) for the given
 * selections, before YAML serialization. Exposed separately so callers that
 * want the plain JS object (e.g. parser round-trip tests) don't have to
 * re-parse YAML.
 */
export function buildModelBundleObject(bundleName: string, selections: ModelBundleSelection[]): ModelBundle {
  const modelConfigs: ModelConfigEntry[] = [];
  // Track which models survived (by crname) so spec-decoding pairs referencing a
  // dropped model can be pruned.
  const keptCrnames = new Set<string>();
  const keptDrafts: (ModelBundleSelection & { isDraftFor: string })[] = [];

  for (const selection of selections) {
    const isEmbedding = isEmbeddingModel(selection.model);
    const profileDefault = getEffectiveBatchingConfig(selection.profile);
    const baseBatchingConfig = dropEmptyTiers(selection.batchingConfigOverride ?? profileDefault);

    // Drop the model from the bundle entirely when its batching config was fully
    // cleared in Step 3 — i.e. it's empty now, but the profile had a non-empty
    // default to clear (a profile with no batching config to begin with is kept).
    if (Object.keys(baseBatchingConfig).length === 0 && Object.keys(profileDefault).length > 0) {
      continue;
    }

    const batchingConfig = deriveIsDefaultTier(baseBatchingConfig, isEmbedding);

    // Insertion order matters here: it drives the emitted YAML key order
    // (model, profile, modelSettings, batchingConfig), matching v3plan.md's
    // worked spec-decoding example.
    const entry: ModelConfigEntry = {
      model: formatModelRef(selection.model, selection.arch, selection.versionOverride),
      profile: selection.profile.metadata.name,
    };

    // modelSettings only appears when something diverges from the operator
    // defaults: routable is inverted to false for spec-decoding drafts, and
    // swappable is emitted only when the user turns off the (default-true)
    // Advanced Options toggle.
    const modelSettings: NonNullable<ModelConfigEntry['modelSettings']> = {};
    if (selection.isDraftFor) {
      modelSettings.routable = false;
    }
    if (selection.swappable === false) {
      modelSettings.swappable = false;
    }
    if (Object.keys(modelSettings).length > 0) {
      entry.modelSettings = modelSettings;
    }

    // Only emit batchingConfig when it diverges from what the operator would use
    // by default (the profile's effective batching config); an identical config
    // is redundant. A tier left at the `'*'` sentinel means "the profile default's
    // batch sizes", so resolve those before comparing — otherwise a selection that
    // equals the default but is expressed with `'*'` (e.g. every batch size left
    // checked, or a reloaded bundle) looks different and gets emitted redundantly.
    // When emitted, keep the original (`'*'`-preserving) config and order tiers by
    // descending sequence length; the downstream collapse step shrinks it.
    if (!batchingConfigsEqual(resolveWildcardTiers(batchingConfig, profileDefault), profileDefault)) {
      entry.batchingConfig = orderBatchingConfigDescending(batchingConfig);
    }

    modelConfigs.push(entry);
    keptCrnames.add(selection.model.metadata.name);
    if (selection.isDraftFor) {
      keptDrafts.push(selection as ModelBundleSelection & { isDraftFor: string });
    }
  }

  const specDecodingPairs: SpecDecodingPair[] = keptDrafts
    // Prune pairs whose target model was dropped (the draft itself is kept by construction).
    .filter((selection) => keptCrnames.has(selection.isDraftFor))
    .map((selection) => ({
      draft: selection.model.metadata.name,
      target: selection.isDraftFor,
    }));

  return {
    metadata: { name: bundleName },
    spec: {
      modelConfigs,
      ...(specDecodingPairs.length > 0 ? { specDecodingPairs } : {}),
    },
  };
}

/**
 * Builds a single `ModelBundle` YAML document from the given selections
 * (`apiVersion: sambanova.ai/v1alpha1`, `kind: ModelBundle`), serialized with
 * `js-yaml`'s `dump()` (not hand-built template strings). No `secretNames`
 * is emitted (Q7) — profiles carry them.
 */
export function generateModelBundleYaml(bundleName: string, selections: ModelBundleSelection[]): string {
  const bundle = buildModelBundleObject(bundleName, selections);

  // Map each emitted modelConfigs entry (by its model ref) back to its profile's
  // effective default batching config, so tiers left at the default can be
  // collapsed to the `'*'` sentinel purely for a shorter YAML document. This is
  // a serialization-only step: `buildModelBundleObject` keeps the explicit
  // batch-size lists so callers wanting the plain object still see real arrays.
  const profileDefaultsByRef = new Map<string, BatchingConfig>();
  for (const selection of selections) {
    const ref = formatModelRef(selection.model, selection.arch, selection.versionOverride);
    profileDefaultsByRef.set(ref, getEffectiveBatchingConfig(selection.profile));
  }

  const modelConfigs = bundle.spec.modelConfigs.map((entry) =>
    entry.batchingConfig
      ? { ...entry, batchingConfig: collapseTiersToWildcard(entry.batchingConfig, profileDefaultsByRef.get(entry.model) ?? {}) }
      : entry
  );

  const document = {
    apiVersion: 'sambanova.ai/v1alpha1',
    kind: 'ModelBundle',
    metadata: bundle.metadata,
    spec: { ...bundle.spec, modelConfigs },
  };

  // flowLevel: 6 renders the deepest collections — the per-tier `batch_sizes`
  // arrays — in flow style (`[1, 4]`) while leaving every shallower mapping and
  // the specDecodingPairs list in block style. This shape is specific to the
  // ModelBundle document produced above (batch_sizes is the only level-6+
  // collection); revisit the level if the emitted structure gains depth.
  return yaml.dump(document, { noRefs: true, lineWidth: -1, flowLevel: 6 });
}

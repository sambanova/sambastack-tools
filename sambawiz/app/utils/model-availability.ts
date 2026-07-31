import type { CheckpointMappingV3, ModelProfilesCache, Model, ModelProfile } from '../types/bundle';
import { isEmbeddingModel } from './bundle-yaml-generator';

/**
 * V3 model availability — joins the `checkpoint_mapping.json` cache (`Model`
 * CRs, multi-arch) against the `model_profiles.json` cache (`ModelProfile`
 * CRs) on `model_arch`, per v3plan.md's "Model↔ModelProfile join on
 * `model_arch`" (Step 1 / Q4 no-profile guard).
 *
 * This module only joins/filters — it deliberately does NOT reimplement
 * embedding detection, display-name derivation, or spec-decoding detection;
 * those live in `bundle-yaml-generator.ts` (`isEmbeddingModel`,
 * `getDisplayName`, `isSpecDecodingProfile`) and are reused as-is. Reusing
 * them here requires reconstructing plain `Model`/`ModelProfile` objects from
 * the flatter cache shapes (`toModelLike` / `toModelProfileLike` below) — that
 * reconstruction is just a shape adapter, not a reimplementation of any of
 * the helpers' logic.
 */

/** One checkpoint arch of an available model, plus the profiles that match it (join on `model_arch`). */
export interface AvailableModelArch {
  arch: string;
  /** `ModelProfile`s whose `spec.model_arch` equals this arch, in cache iteration order. */
  matchingProfiles: ModelProfile[];
}

/** One model (by `Model.spec.name` display name) that has at least one matching profile on at least one arch. */
export interface AvailableModel {
  displayName: string; // Model.spec.name — what the user selects
  resourceName: string; // Model.metadata.name — the crname used in modelConfigs[].model refs
  isEmbedding: boolean; // via isEmbeddingModel (Q10: spec.metadata.capabilities includes "embeddings")
  capabilities: string[]; // Model.spec.metadata.capabilities, e.g. ["text", "vision"] — shown in the model picker
  /** Only archs with >= 1 matching profile are included. Multi-entry => Step-2 arch dropdown (Q3). */
  archs: AvailableModelArch[];
}

export interface ModelAvailabilityResult {
  /** Models with at least one matching ModelProfile on at least one arch, sorted by displayName. */
  available: AvailableModel[];
  /**
   * Display names of models with ZERO matching ModelProfile across every arch
   * (Q4 — "no matching model profile" guard). The future UI surfaces these as
   * blocked-from-bundle with a warning; sorted for stable rendering.
   */
  excludedModelNames: string[];
}

/**
 * Reconstructs a `Model`-shaped object from a `CheckpointMappingV3` entry so
 * `isEmbeddingModel` (which expects the full `Model` CR shape) can be reused
 * without duplicating its capabilities-check logic here.
 */
function toModelLike(displayName: string, entry: CheckpointMappingV3[string]): Model {
  return {
    metadata: { name: entry.resource_name },
    spec: {
      name: displayName,
      checkpoints: entry.checkpoints,
      metadata: { capabilities: entry.capabilities },
    },
  };
}

/**
 * Reconstructs a `ModelProfile`-shaped object from a `ModelProfilesCache`
 * entry (keyed by `metadata.name`), so `getDisplayName` / `isSpecDecodingProfile`
 * can be reused by callers of this module without duplicating their logic.
 */
function toModelProfileLike(profileName: string, entry: ModelProfilesCache[string]): ModelProfile {
  return {
    metadata: { name: profileName },
    spec: {
      model_arch: entry.model_arch,
      features: entry.features,
      defaultBatchingConfig: entry.batchingConfig,
      pefs: entry.pefs,
    },
  };
}

/**
 * Joins the model cache against the model-profiles cache on `model_arch` and
 * applies the no-profile guard (Q4): a model is "available" only if at least
 * one of its checkpoint archs has at least one matching `ModelProfile`.
 * Models with zero matches across every arch are reported in
 * `excludedModelNames` instead of `available`.
 */
export function getAvailableModels(
  checkpointMapping: CheckpointMappingV3,
  modelProfiles: ModelProfilesCache
): ModelAvailabilityResult {
  // Pre-build all profile-like objects once, grouped by model_arch, so the
  // per-model join below is a simple lookup rather than a re-scan.
  const profilesByArch = new Map<string, ModelProfile[]>();
  for (const [profileName, entry] of Object.entries(modelProfiles)) {
    const profile = toModelProfileLike(profileName, entry);
    const bucket = profilesByArch.get(entry.model_arch);
    if (bucket) {
      bucket.push(profile);
    } else {
      profilesByArch.set(entry.model_arch, [profile]);
    }
  }

  const available: AvailableModel[] = [];
  const excludedModelNames: string[] = [];

  for (const [displayName, entry] of Object.entries(checkpointMapping)) {
    const archs: AvailableModelArch[] = [];

    for (const arch of Object.keys(entry.checkpoints)) {
      const matchingProfiles = profilesByArch.get(arch);
      if (matchingProfiles && matchingProfiles.length > 0) {
        archs.push({ arch, matchingProfiles });
      }
    }

    if (archs.length === 0) {
      excludedModelNames.push(displayName);
      continue;
    }

    available.push({
      displayName,
      resourceName: entry.resource_name,
      isEmbedding: isEmbeddingModel(toModelLike(displayName, entry)),
      capabilities: entry.capabilities ?? [],
      archs,
    });
  }

  available.sort((a, b) => a.displayName.localeCompare(b.displayName));
  excludedModelNames.sort((a, b) => a.localeCompare(b));

  return { available, excludedModelNames };
}

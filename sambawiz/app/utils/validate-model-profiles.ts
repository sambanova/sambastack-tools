import type { BatchingConfig, ModelProfilesCache } from '../types/bundle';

/**
 * Checks on the cached ModelProfile data, and a comparison against what the
 * cluster serves now. The bundle generator removes a model whose batching
 * config resolves empty, so a profile that resolves empty costs the user a
 * model. These checks name that profile before a bundle reaches a cluster.
 */

export interface ProfileIssue {
  profile: string;
  kind: 'empty-tiers' | 'empty-tier';
  detail: string;
}

export type ProfileDriftKind = 'added' | 'removed' | 'batching-changed';

export interface ProfileDrift {
  profile: string;
  kind: ProfileDriftKind;
}

/** Where a cached batching config came from, per profile. */
export type BatchingSource = 'spec.defaultBatchingConfig' | 'status.batchingConfig' | 'none';

export interface ModelProfilesCacheMeta {
  /** The app-config kubeconfig entry the cache was built from. */
  kubeconfig: string;
  namespace: string;
  generatedAt: string;
  batchingSource: Record<string, BatchingSource>;
}

function tiersWithNoBatchSize(batchingConfig: BatchingConfig): string[] {
  return Object.entries(batchingConfig)
    .filter(([, cfg]) => Array.isArray(cfg.batch_sizes) && cfg.batch_sizes.length === 0)
    .map(([tier]) => tier);
}

/**
 * Reports profiles whose batching config cannot deploy a model. A profile with
 * no batching config at all is fine, because the operator supplies one at
 * deploy time.
 */
export function validateModelProfilesCache(cache: ModelProfilesCache): ProfileIssue[] {
  const issues: ProfileIssue[] = [];

  for (const [profile, entry] of Object.entries(cache)) {
    const tiers = Object.keys(entry.batchingConfig);
    if (tiers.length === 0) continue;

    const empty = tiersWithNoBatchSize(entry.batchingConfig);
    if (empty.length === 0) continue;

    if (empty.length === tiers.length) {
      issues.push({
        profile,
        kind: 'empty-tiers',
        detail: `No tier offers a batch size (${empty.join(', ')}). A model on this profile cannot be deployed.`,
      });
    } else {
      issues.push({
        profile,
        kind: 'empty-tier',
        detail: `Tiers with no batch size: ${empty.join(', ')}.`,
      });
    }
  }

  return issues;
}

function batchingConfigsMatch(a: BatchingConfig, b: BatchingConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compares the cached profiles against the profiles the cluster serves now.
 * A bundle built from a stale cache names profiles the cluster does not have,
 * or batching configs it no longer publishes.
 */
export function diffModelProfilesCaches(
  cached: ModelProfilesCache,
  live: ModelProfilesCache
): ProfileDrift[] {
  const drift: ProfileDrift[] = [];

  for (const profile of Object.keys(cached)) {
    if (!(profile in live)) {
      drift.push({ profile, kind: 'removed' });
      continue;
    }
    if (!batchingConfigsMatch(cached[profile].batchingConfig, live[profile].batchingConfig)) {
      drift.push({ profile, kind: 'batching-changed' });
    }
  }

  for (const profile of Object.keys(live)) {
    if (!(profile in cached)) {
      drift.push({ profile, kind: 'added' });
    }
  }

  return drift;
}

/** Describes drift in one line, for an alert or a CLI message. */
export function describeDrift(drift: ProfileDrift[]): string {
  const counts = { added: 0, removed: 0, 'batching-changed': 0 };
  drift.forEach((d) => (counts[d.kind] += 1));

  const parts: string[] = [];
  if (counts.removed) parts.push(`${counts.removed} no longer on the cluster`);
  if (counts['batching-changed']) parts.push(`${counts['batching-changed']} with a changed batching config`);
  if (counts.added) parts.push(`${counts.added} new`);

  return `Cached model profiles differ from the cluster: ${parts.join(', ')}.`;
}

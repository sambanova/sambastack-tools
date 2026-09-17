import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { BatchingConfig, ModelProfilesCache } from '../../types/bundle';
import {
  diffModelProfilesCaches,
  validateModelProfilesCache,
  type ModelProfilesCacheMeta,
} from '../../utils/validate-model-profiles';

/**
 * Compares the cached ModelProfile data against what the cluster serves now.
 * The bundle generator resolves each model's batching config from the cache, so
 * a stale cache silently changes the bundle it produces. Call this before
 * applying a bundle.
 */

interface KubeconfigEntry {
  file: string;
  namespace: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

interface ModelProfileItem {
  metadata: { name: string };
  spec: {
    model_arch: string;
    features?: string[];
    defaultBatchingConfig?: BatchingConfig;
    pefs?: string[];
  };
  status?: { batchingConfig?: BatchingConfig };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function POST() {
  try {
    const config: AppConfig = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'app-config.json'), 'utf-8')
    );
    const currentEnv = config.currentKubeconfig;
    const entry = currentEnv ? config.kubeconfigs[currentEnv] : undefined;

    if (!entry?.file) {
      return NextResponse.json({ success: false, error: 'No kubeconfig file configured' }, { status: 400 });
    }
    const namespace = entry.namespace || 'default';

    const dataDir = path.join(process.cwd(), 'app', 'data');
    const cached = await readJson<ModelProfilesCache>(path.join(dataDir, 'model_profiles.json'));
    const meta = await readJson<ModelProfilesCacheMeta>(path.join(dataDir, 'model_profiles.meta.json'));

    if (!cached) {
      return NextResponse.json({
        success: false,
        error: 'No cached model profiles to compare. Refresh the cluster data first.',
      }, { status: 400 });
    }

    let kubectlOutput: string;
    try {
      kubectlOutput = execSync(`kubectl -n ${namespace} get modelprofiles -o json`, {
        env: { ...process.env, KUBECONFIG: path.join(process.cwd(), entry.file) },
        timeout: 60000,
        encoding: 'utf-8',
        maxBuffer: 100 * 1024 * 1024,
      });
    } catch (kubectlError) {
      const message = kubectlError instanceof Error ? kubectlError.message : String(kubectlError);
      return NextResponse.json({
        success: false,
        error: `Could not read model profiles from the cluster: ${message}`,
      }, { status: 502 });
    }

    const live: ModelProfilesCache = {};
    const items = (JSON.parse(kubectlOutput) as { items: ModelProfileItem[] }).items ?? [];
    for (const item of items) {
      const name = item.metadata?.name;
      const modelArch = item.spec?.model_arch;
      if (!name || !modelArch) continue;
      live[name] = {
        model_arch: modelArch,
        features: item.spec.features ?? [],
        batchingConfig: item.spec.defaultBatchingConfig ?? item.status?.batchingConfig ?? {},
        pefs: item.spec.pefs ?? [],
      };
    }

    // A cache built against another cluster resolves profiles that this one may not
    // have, so report it even when the profile data happens to agree.
    const clusterChanged = Boolean(
      meta && (meta.kubeconfig !== (currentEnv ?? '') || meta.namespace !== namespace)
    );

    return NextResponse.json({
      success: true,
      clusterChanged,
      cachedFrom: meta ? { kubeconfig: meta.kubeconfig, namespace: meta.namespace, generatedAt: meta.generatedAt } : null,
      drift: diffModelProfilesCaches(cached, live),
      issues: validateModelProfilesCache(live),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      success: false,
      error: `Failed to compare model profiles: ${message}`,
    }, { status: 500 });
  }
}

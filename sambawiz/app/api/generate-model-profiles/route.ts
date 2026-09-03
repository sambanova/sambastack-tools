import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { BatchingConfig, ModelProfilesCache } from '../../types/bundle';
import { ensureAppDataDir } from '../../utils/ensure-app-data-dir';

/**
 * Mirrors `generate-checkpoint-mapping/route.ts`'s app-config.json ->
 * kubeconfig/namespace resolution, but caches `ModelProfile` CRs instead of
 * `Model` CRs (see v3plan.md, "Data fetching & caching for V3 (Q14)").
 */

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

interface ModelProfileItem {
  metadata: {
    name: string;
  };
  spec: {
    model_arch: string;
    features?: string[];
    defaultBatchingConfig?: BatchingConfig;
    pefs?: string[];
  };
  status?: {
    batchingConfig?: BatchingConfig;
  };
}

interface KubectlOutput {
  items: ModelProfileItem[];
}

export async function POST() {
  try {
    // Read app-config.json to get current environment configuration
    const configPath = path.join(process.cwd(), 'app-config.json');
    let kubeconfigFile = '';
    let namespace = 'default';

    const configContent = await fs.readFile(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);

    const currentEnv = config.currentKubeconfig;
    if (currentEnv && config.kubeconfigs[currentEnv]) {
      kubeconfigFile = config.kubeconfigs[currentEnv].file;
      namespace = config.kubeconfigs[currentEnv].namespace || 'default';
    }

    if (!kubeconfigFile) {
      return NextResponse.json({
        success: false,
        error: 'No kubeconfig file configured',
      }, { status: 400 });
    }

    const kubeconfigPath = path.join(process.cwd(), kubeconfigFile);
    const env = { ...process.env, KUBECONFIG: kubeconfigPath };

    // Run kubectl get modelprofiles. A backend that only supports v2 bundles has no
    // ModelProfile CRD, so kubectl fails with "the server doesn't have a resource type".
    // Surface that as a clear, actionable v3-support error instead of a raw 500.
    let kubectlOutput: string;
    try {
      kubectlOutput = execSync(`kubectl -n ${namespace} get modelprofiles -o json`, {
        env,
        timeout: 60000,
        encoding: 'utf-8',
        maxBuffer: 100 * 1024 * 1024,
      });
    } catch (kubectlError) {
      const stderr = (kubectlError && typeof kubectlError === 'object' && 'stderr' in kubectlError)
        ? String((kubectlError as { stderr?: unknown }).stderr ?? '')
        : '';
      const message = kubectlError instanceof Error ? kubectlError.message : String(kubectlError);
      const combined = `${message}\n${stderr}`;
      if (/doesn't have a resource type|could not find the requested resource|server could not find|no matches for kind|resource type.*modelprofile/i.test(combined)) {
        return NextResponse.json({
          success: false,
          error:
            "This environment's backend does not support v3 bundles: the ModelProfile CRD " +
            '(modelprofiles.sambanova.ai) was not found. SambaWiz 2.x requires a SambaStack ' +
            'backend that provides ModelProfile/ModelBundle. Please upgrade the backend or ' +
            'select a v3-capable environment.',
        }, { status: 400 });
      }
      throw kubectlError; // unrelated failure — handled by the outer catch as a 500
    }

    const profilesData: KubectlOutput = JSON.parse(kubectlOutput);
    const modelProfiles: ModelProfilesCache = {};

    for (const item of profilesData.items) {
      const profileName = item.metadata?.name;
      const modelArch = item.spec?.model_arch;

      if (!profileName || !modelArch) continue;

      modelProfiles[profileName] = {
        model_arch: modelArch,
        features: item.spec.features ?? [],
        batchingConfig: item.spec.defaultBatchingConfig ?? item.status?.batchingConfig ?? {},
        pefs: item.spec.pefs ?? [],
      };
    }

    // Write the generated cache to app/data/model_profiles.json
    const outputPath = path.join(ensureAppDataDir(), 'model_profiles.json');
    await fs.writeFile(outputPath, JSON.stringify(modelProfiles, null, 2));

    return NextResponse.json({
      success: true,
      count: Object.keys(modelProfiles).length,
    });
  } catch (error) {
    console.error('Error generating model profiles:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      success: false,
      error: `Failed to generate model profiles: ${message}`,
    }, { status: 500 });
  }
}

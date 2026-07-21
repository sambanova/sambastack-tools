import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { BatchingConfig, ModelProfilesCache } from '../../types/bundle';

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
  checkpointsDir: string;
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

    // Run kubectl get modelprofiles
    const kubectlOutput = execSync(`kubectl -n ${namespace} get modelprofiles -o json`, {
      env,
      timeout: 60000,
      encoding: 'utf-8',
    });

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
    const outputPath = path.join(process.cwd(), 'app/data/model_profiles.json');
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

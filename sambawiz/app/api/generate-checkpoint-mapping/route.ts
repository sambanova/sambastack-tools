import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { CheckpointMappingV3 } from '../../types/bundle';
import { ensureAppDataDir } from '../../utils/ensure-app-data-dir';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

interface CheckpointVersion {
  checkpoint_status?: string;
  source: string;
  tool_support?: boolean;
  vision_embedding_checkpoint?: string;
}

interface CheckpointEntry {
  versions: Record<string, CheckpointVersion>;
}

interface ModelSpec {
  name: string;
  checkpoints: Record<string, CheckpointEntry>;
  metadata: {
    capabilities?: string[];
  };
}

interface ModelItem {
  metadata: {
    name: string;
  };
  spec: ModelSpec;
}

interface KubectlOutput {
  items: ModelItem[];
}

function stripGcsPrefix(gcsPath: string): string {
  // Strip gs://bucket-name/ prefix and trailing slash
  return gcsPath.replace(/^gs:\/\/[^/]+\//, '').replace(/\/$/, '');
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

    // Run kubectl get models
    const kubectlOutput = execSync(`kubectl -n ${namespace} get models -o json`, {
      env,
      timeout: 60000,
      encoding: 'utf-8',
    });

    const modelsData: KubectlOutput = JSON.parse(kubectlOutput);
    const checkpointMapping: CheckpointMappingV3 = {};

    for (const item of modelsData.items) {
      const modelName = item.spec.name;
      const resourceName = item.metadata.name;
      const checkpoints = item.spec.checkpoints;

      if (!modelName || !resourceName || !checkpoints) continue;

      const archs: CheckpointMappingV3[string]['checkpoints'] = {};

      // Capture ALL checkpoint archs (not just the first one) so the builder
      // can offer the Step-2 arch dropdown for multi-arch models (v3plan.md).
      for (const [arch, checkpointEntry] of Object.entries(checkpoints)) {
        const versions = checkpointEntry?.versions;
        if (!versions || Object.keys(versions).length === 0) continue;

        const archVersions: CheckpointEntry['versions'] = {};
        for (const [version, versionData] of Object.entries(versions)) {
          if (!versionData?.source) continue;

          archVersions[version] = {
            source: stripGcsPrefix(versionData.source),
            ...(versionData.checkpoint_status ? { checkpoint_status: versionData.checkpoint_status } : {}),
            ...(versionData.tool_support !== undefined ? { tool_support: versionData.tool_support } : {}),
            ...(versionData.vision_embedding_checkpoint
              ? { vision_embedding_checkpoint: stripGcsPrefix(versionData.vision_embedding_checkpoint) }
              : {}),
          };
        }

        if (Object.keys(archVersions).length > 0) {
          archs[arch] = { versions: archVersions };
        }
      }

      if (Object.keys(archs).length === 0) continue;

      checkpointMapping[modelName] = {
        resource_name: resourceName,
        checkpoints: archs,
        capabilities: item.spec.metadata?.capabilities ?? [],
      };
    }

    // Write the generated mapping to app/data/checkpoint_mapping.json
    const outputPath = path.join(ensureAppDataDir(), 'checkpoint_mapping.json');
    await fs.writeFile(outputPath, JSON.stringify(checkpointMapping, null, 2));

    // Re-run PEF config generation (still needed for the PEF SS/BS/version cache).
    const { generatePefConfigs } = await import('../../utils/pef-config-generator');
    await generatePefConfigs();

    return NextResponse.json({
      success: true,
      count: Object.keys(checkpointMapping).length,
    });
  } catch (error) {
    console.error('Error generating checkpoint mapping:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      success: false,
      error: `Failed to generate checkpoint mapping: ${message}`,
    }, { status: 500 });
  }
}

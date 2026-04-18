import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
}

interface AppConfig {
  checkpointsDir: string;
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
  checkpoint_overrides?: Record<string, string>;
}

interface CheckpointVersion {
  source: string;
  vision_embedding_checkpoint?: string;
  tool_support?: boolean;
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

interface CheckpointMappingEntry {
  path: string;
  resource_name: string;
  vision_embedding_checkpoint?: string;
  model_type?: string;
}

function stripGcsPrefix(gcsPath: string): string {
  // Strip gs://bucket-name/ prefix and trailing slash
  return gcsPath.replace(/^gs:\/\/[^/]+\//, '').replace(/\/$/, '');
}

function getHighestVersion(versions: Record<string, CheckpointVersion>): string {
  const keys = Object.keys(versions);
  return keys.sort((a, b) => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (aParts[i] || 0) - (bParts[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  })[keys.length - 1];
}

export async function POST() {
  try {
    // Read app-config.json to get current environment configuration
    const configPath = path.join(process.cwd(), 'app-config.json');
    let kubeconfigFile = '';
    let namespace = 'default';

    const configContent = await fs.readFile(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);
    const checkpointOverrides: Record<string, string> = config.checkpoint_overrides || {};

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
    const checkpointMapping: Record<string, CheckpointMappingEntry> = {};

    for (const item of modelsData.items) {
      const modelName = item.spec.name;
      const resourceName = item.metadata.name;
      const checkpoints = item.spec.checkpoints;

      if (!modelName || !resourceName || !checkpoints) continue;

      const firstCheckpointKey = Object.keys(checkpoints)[0];
      if (!firstCheckpointKey) continue;

      const versions = checkpoints[firstCheckpointKey].versions;
      if (!versions || Object.keys(versions).length === 0) continue;

      const overrideVersion = checkpointOverrides[modelName];
      const selectedVersion = (overrideVersion && versions[overrideVersion])
        ? overrideVersion
        : getHighestVersion(versions);
      const versionData = versions[selectedVersion];

      if (!versionData?.source) continue;

      const entry: CheckpointMappingEntry = {
        path: stripGcsPrefix(versionData.source),
        resource_name: resourceName,
      };

      if (versionData.vision_embedding_checkpoint) {
        entry.vision_embedding_checkpoint = stripGcsPrefix(versionData.vision_embedding_checkpoint);
      }

      checkpointMapping[modelName] = entry;
    }

    // Write the generated mapping to app/data/checkpoint_mapping.json
    const outputPath = path.join(process.cwd(), 'app/data/checkpoint_mapping.json');
    await fs.writeFile(outputPath, JSON.stringify(checkpointMapping, null, 2));

    // Re-run PEF config generation so model_type (e.g. "embedding") is populated
    // on the freshly written checkpoint_mapping.json from PEF spec.metadata.task_name
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

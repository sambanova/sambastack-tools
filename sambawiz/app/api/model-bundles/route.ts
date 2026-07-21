import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
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
}

/**
 * Minimal summary of a `ModelBundle` CR (replaces the old `Bundle`), just
 * enough for the Model Deployment page's bundle picker: the name to
 * reference (`spec.bundle` on the ModelDeployment), its validity, and which
 * models/profiles it combines. There is no `spec.template` in v3 (that was
 * the V2 BundleTemplate reference) — `modelConfigs` replaces it.
 */
interface ModelBundleSummary {
  name: string;
  namespace: string;
  creationTimestamp: string;
  isValid: boolean;
  validationReason: string;
  validationMessage: string;
  modelConfigs: Array<{ model: string; profile?: string }>;
}

/**
 * GET - Fetch all model bundles
 */
export async function GET() {
  try {
    // Read app-config.json to get current kubeconfig and namespace
    const configPath = path.join(process.cwd(), 'app-config.json');
    if (!existsSync(configPath)) {
      return NextResponse.json(
        {
          success: false,
          error: 'app-config.json not found. Please configure an environment first.'
        },
        { status: 400 }
      );
    }

    const configContent = readFileSync(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);

    const currentEnv = config.currentKubeconfig;
    if (!currentEnv || !config.kubeconfigs[currentEnv]) {
      return NextResponse.json(
        {
          success: false,
          error: 'No active environment configured. Please select an environment first.'
        },
        { status: 400 }
      );
    }

    const kubeconfigFile = config.kubeconfigs[currentEnv].file;
    const namespace = config.kubeconfigs[currentEnv].namespace || 'default';

    const kubeconfigPath = path.join(process.cwd(), kubeconfigFile);
    if (!existsSync(kubeconfigPath)) {
      return NextResponse.json(
        {
          success: false,
          error: `Kubeconfig file not found: ${kubeconfigFile}`
        },
        { status: 400 }
      );
    }

    const env = { ...process.env, KUBECONFIG: kubeconfigPath };

    const output = execSync(`kubectl -n ${namespace} get modelbundle.sambanova.ai -o json`, {
      encoding: 'utf-8',
      env,
      timeout: 30000,
    });

    const data = JSON.parse(output);

    // Transform the data to a more usable format
    const bundles: ModelBundleSummary[] = data.items.map((item: {
      metadata: { name: string; namespace: string; creationTimestamp: string };
      spec: { modelConfigs?: Array<{ model: string; profile?: string }> };
      status?: {
        conditions?: Array<{
          type?: string;
          status?: string;
          reason?: string;
          message?: string;
        }>;
      };
    }) => {
      const condition = item.status?.conditions?.[0];
      const isValid = condition?.reason === 'ValidationSucceeded' || condition?.status === 'True';

      return {
        name: item.metadata.name,
        namespace: item.metadata.namespace,
        creationTimestamp: item.metadata.creationTimestamp,
        isValid,
        validationReason: condition?.reason || 'Unknown',
        validationMessage: condition?.message || '',
        modelConfigs: (item.spec.modelConfigs || []).map((mc) => ({
          model: mc.model,
          profile: mc.profile,
        })),
      };
    });

    return NextResponse.json({
      success: true,
      bundles,
    });
  } catch (error) {
    console.error('Failed to fetch model bundles:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stderr = (error && typeof error === 'object' && 'stderr' in error)
      ? String(error.stderr)
      : '';
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch model bundles',
        message,
        stderr,
      },
      { status: 500 }
    );
  }
}

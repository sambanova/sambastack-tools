import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

/**
 * Summary of a `ModelDeployment` CR (replaces the old `BundleDeployment`).
 * `bundle` comes from `spec.bundle` — same field name as the old
 * `BundleDeployment.spec.bundle`, since SambaWiz always emits a named
 * `spec.bundle` reference (never inline `spec.models`, per v3plan.md Q6).
 */
interface ModelDeploymentSummary {
  name: string;
  namespace: string;
  bundle: string;
  creationTimestamp: string;
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      reason: string;
      message: string;
    }>;
  };
}

/**
 * GET - Fetch all model deployments
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

    const output = execSync(`kubectl -n ${namespace} get modeldeployment.sambanova.ai -o json`, {
      encoding: 'utf-8',
      env,
      timeout: 30000,
    });

    const data = JSON.parse(output);

    // Transform the data to a more usable format
    const bundleDeployments: ModelDeploymentSummary[] = data.items.map((item: {
      metadata: { name: string; namespace: string; creationTimestamp: string };
      spec: { bundle: string };
      status?: ModelDeploymentSummary['status'];
    }) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      bundle: item.spec.bundle,
      creationTimestamp: item.metadata.creationTimestamp,
      status: item.status,
    }));

    return NextResponse.json({
      success: true,
      bundleDeployments,
    });
  } catch (error) {
    console.error('Failed to fetch model deployments:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stderr = (error && typeof error === 'object' && 'stderr' in error)
      ? String(error.stderr)
      : '';
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch model deployments',
        message,
        stderr,
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Delete a model deployment
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Model deployment name is required' },
        { status: 400 }
      );
    }

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

    const output = execSync(`kubectl -n ${namespace} delete modeldeployment.sambanova.ai ${name}`, {
      encoding: 'utf-8',
      env,
      timeout: 30000,
    });

    return NextResponse.json({
      success: true,
      message: `Model deployment ${name} deleted successfully`,
      output: output.trim(),
    });
  } catch (error) {
    console.error('Failed to delete model deployment:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stderr = (error && typeof error === 'object' && 'stderr' in error)
      ? String(error.stderr)
      : '';
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete model deployment',
        message,
        stderr,
      },
      { status: 500 }
    );
  }
}

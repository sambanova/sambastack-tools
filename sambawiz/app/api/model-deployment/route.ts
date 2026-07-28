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
 * A deployment is either bundle-based (`spec.bundle` — a named `ModelBundle`
 * reference) or model-based (`spec.models.modelConfigs[]` — an inline model +
 * profile). For model-based deployments `spec.bundle` is empty, so we instead
 * resolve the referenced Model CR's display name (`spec.name`) into `model`.
 */
interface ModelDeploymentSummary {
  name: string;
  namespace: string;
  /** `spec.bundle` (a `ModelBundle` name), or '' for a model-based deployment. */
  bundle: string;
  /** The Model CR's `spec.name` for a model-based deployment; undefined for a bundle. */
  model?: string;
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

    interface ModelDeploymentItem {
      metadata: { name: string; namespace: string; creationTimestamp: string };
      spec: {
        bundle?: string;
        models?: { modelConfigs?: Array<{ model?: string }> };
      };
      status?: ModelDeploymentSummary['status'];
    }

    const items: ModelDeploymentItem[] = data.items || [];

    // A model-based deployment inlines models via `spec.models.modelConfigs`
    // (see generateModelDeploymentYaml) and leaves `spec.bundle` empty.
    const isModelBased = (item: ModelDeploymentItem) =>
      !item.spec?.bundle &&
      Array.isArray(item.spec?.models?.modelConfigs) &&
      item.spec.models!.modelConfigs!.length > 0;

    // Resolve Model CR `metadata.name` (crname) -> `spec.name` (display name),
    // but only if there's actually a model-based deployment to name (avoids the
    // extra kubectl call otherwise). A `modelConfigs[].model` ref is
    // "<crname>[:<arch>][:<version>]"; the crname is the part before the first ":".
    const modelNameByResource: Record<string, string> = {};
    if (items.some(isModelBased)) {
      try {
        const modelsOutput = execSync(`kubectl -n ${namespace} get models -o json`, {
          encoding: 'utf-8',
          env,
          timeout: 30000,
        });
        const modelsData = JSON.parse(modelsOutput);
        for (const m of modelsData.items || []) {
          const resource = m?.metadata?.name;
          const display = m?.spec?.name;
          if (resource && display) modelNameByResource[resource] = display;
        }
      } catch (modelsError) {
        // Non-fatal: fall back to the raw crname from the model ref below.
        console.error('Failed to fetch models for deployment name resolution:', modelsError);
      }
    }

    // Transform the data to a more usable format
    const bundleDeployments: ModelDeploymentSummary[] = items.map((item) => {
      let model: string | undefined;
      if (isModelBased(item)) {
        const names = item.spec.models!.modelConfigs!
          .map((mc) => String(mc.model || '').split(':')[0])
          .filter(Boolean)
          .map((crname) => modelNameByResource[crname] || crname);
        if (names.length > 0) model = Array.from(new Set(names)).join(', ');
      }
      return {
        name: item.metadata.name,
        namespace: item.metadata.namespace,
        bundle: item.spec?.bundle || '',
        model,
        creationTimestamp: item.metadata.creationTimestamp,
        status: item.status,
      };
    });

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

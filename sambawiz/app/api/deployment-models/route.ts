import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parseModelRef } from '../../utils/parse-bundle-yaml';
import type { CheckpointMapping } from '../../types/bundle';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const deploymentName = searchParams.get('deploymentName');

    if (!deploymentName) {
      return NextResponse.json(
        { success: false, error: 'deploymentName parameter is required' },
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

    // Step 1: Get the ModelDeployment to extract the bundle name
    let modelDeploymentOutput: string;
    try {
      modelDeploymentOutput = execSync(
        `kubectl get modeldeployment.sambanova.ai ${deploymentName} -n ${namespace} -o json`,
        {
          encoding: 'utf-8',
          env,
          timeout: 30000,
        }
      );
    } catch (error) {
      console.error('Error getting model deployment:', error);
      const details = error instanceof Error ? error.message : 'Unknown error';
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to get model deployment',
          details,
          stderr,
        },
        { status: 500 }
      );
    }

    // Parse the ModelDeployment JSON
    let modelDeployment: {
      spec?: {
        bundle?: string;
      };
    };
    try {
      modelDeployment = JSON.parse(modelDeploymentOutput);
    } catch (error) {
      console.error('Error parsing model deployment JSON:', error);
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to parse model deployment data',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
        { status: 500 }
      );
    }

    // Extract bundle name from spec
    const bundleName = modelDeployment?.spec?.bundle;
    if (!bundleName) {
      return NextResponse.json(
        {
          success: false,
          error: 'Bundle name not found in deployment spec',
        },
        { status: 404 }
      );
    }

    // Step 2: Get the ModelBundle to extract the models
    let modelBundleOutput: string;
    try {
      modelBundleOutput = execSync(
        `kubectl get modelbundle.sambanova.ai ${bundleName} -n ${namespace} -o json`,
        {
          encoding: 'utf-8',
          env,
          timeout: 30000,
        }
      );
    } catch (error) {
      console.error('Error getting model bundle:', error);
      const details = error instanceof Error ? error.message : 'Unknown error';
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to get model bundle',
          details,
          stderr,
        },
        { status: 500 }
      );
    }

    // Parse the ModelBundle JSON
    let modelBundle: {
      spec?: {
        modelConfigs?: Array<{ model?: string }>;
      };
    };
    try {
      modelBundle = JSON.parse(modelBundleOutput);
    } catch (error) {
      console.error('Error parsing model bundle JSON:', error);
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to parse model bundle data',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
        { status: 500 }
      );
    }

    // Extract model crnames from spec.modelConfigs[] (a list in v3, replacing
    // the old v2 spec.models object keyed by model name).
    const modelConfigs = modelBundle?.spec?.modelConfigs;
    if (!Array.isArray(modelConfigs) || modelConfigs.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Models not found in bundle spec',
        },
        { status: 404 }
      );
    }

    const crnames = modelConfigs
      .map((entry) => (typeof entry?.model === 'string' ? parseModelRef(entry.model).crname : undefined))
      .filter((crname): crname is string => Boolean(crname));

    // Reverse-map crname -> display name via checkpoint_mapping.json (same
    // byCrname lookup pattern used in ModelSelection.tsx), so the Playground
    // dropdown keeps showing/using the same display names it always has.
    let checkpointMapping: CheckpointMapping = {};
    try {
      const checkpointMappingPath = path.join(process.cwd(), 'app/data/checkpoint_mapping.json');
      if (existsSync(checkpointMappingPath)) {
        checkpointMapping = JSON.parse(readFileSync(checkpointMappingPath, 'utf-8'));
      }
    } catch (error) {
      console.warn('Failed to load checkpoint_mapping.json for display-name lookup:', error);
    }

    const byCrname: Record<string, string> = {};
    Object.entries(checkpointMapping).forEach(([displayName, entry]) => {
      byCrname[entry.resource_name] = displayName;
    });

    // Fall back to the bare crname when it isn't in the cache, so unmapped
    // models still show up instead of silently disappearing. De-dupe in case
    // multiple entries resolve to the same display name.
    const modelNames = Array.from(new Set(crnames.map((crname) => byCrname[crname] ?? crname))).sort(
      (a, b) => a.toLowerCase().localeCompare(b.toLowerCase())
    );

    return NextResponse.json({
      success: true,
      deploymentName,
      bundleName,
      models: modelNames,
    });
  } catch (error) {
    console.error('Unexpected error in deployment-models API:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'An unexpected error occurred',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

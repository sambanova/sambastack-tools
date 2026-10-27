import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { DEFAULT_NAMESPACE } from '@/app/utils/namespace';
import { validateResourceName } from '@/app/utils/resource-names';
import { deploymentConditionOutcome } from '@/app/utils/deployment-conditions';

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
 * GET - `kubectl describe` a model deployment, plus the outcome its
 * `status.conditions` report (read from `-o json`, since describe prints
 * multi-line condition messages unindented and can't be parsed reliably).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const deploymentName = searchParams.get('deploymentName');

    if (!deploymentName || validateResourceName(deploymentName)) {
      return NextResponse.json(
        { error: 'A valid deployment name is required' },
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
    const namespace = config.kubeconfigs[currentEnv].namespace || DEFAULT_NAMESPACE;

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
    const resource = `modeldeployment.sambanova.ai ${deploymentName}`;

    try {
      const md = JSON.parse(execSync(`kubectl -n ${namespace} get ${resource} -o json`, {
        encoding: 'utf-8',
        env,
        timeout: 10000,
      }));
      const describe = execSync(`kubectl -n ${namespace} describe ${resource}`, {
        encoding: 'utf-8',
        env,
        timeout: 10000,
      });
      const { outcome, condition } = deploymentConditionOutcome(md);

      return NextResponse.json({
        success: true,
        deploymentName,
        command: `kubectl -n ${namespace} describe modeldeployment ${deploymentName}`,
        describe,
        conditions: md.status?.conditions ?? [],
        outcome,
        condition,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';
      return NextResponse.json({
        success: false,
        error: 'Failed to describe model deployment',
        message,
        stderr,
        deploymentName,
      });
    }
  } catch (error) {
    console.error('Deployment describe error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

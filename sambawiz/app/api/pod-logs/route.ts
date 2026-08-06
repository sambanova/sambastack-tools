import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { cachePodName, defaultPodName } from '@/app/utils/inference-pod-names';

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
 * GET - Fetch last N lines of pod logs
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lines = searchParams.get('lines') || '5';
    const container = searchParams.get('container');

    // Preferred: resolve the pod name from the deployment name + type so the
    // operator's truncate+hash naming is applied (see inference-pod-names).
    // Falls back to an explicit `podName` for backwards compatibility.
    const deploymentName = searchParams.get('deploymentName');
    const type = searchParams.get('type'); // 'cache' | 'default'
    let podName = searchParams.get('podName');

    if (!podName && deploymentName && type) {
      if (type === 'cache') {
        podName = cachePodName(deploymentName);
      } else if (type === 'default') {
        podName = defaultPodName(deploymentName);
      } else {
        return NextResponse.json(
          { error: `Invalid pod type: ${type}. Expected 'cache' or 'default'.` },
          { status: 400 }
        );
      }
    }

    if (!podName || typeof podName !== 'string') {
      return NextResponse.json(
        { error: 'Pod name is required (provide podName, or deploymentName and type)' },
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

    try {
      // Run kubectl logs with tail
      const containerFlag = container ? ` -c ${container}` : '';
      const output = execSync(`kubectl -n ${namespace} logs ${podName}${containerFlag} --tail=${lines}`, {
        encoding: 'utf-8',
        env,
        timeout: 10000, // 10 second timeout
      });

      return NextResponse.json({
        success: true,
        logs: output,
        podName,
      });
    } catch (error) {
      // Pod might not exist yet or kubectl command failed
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';
      return NextResponse.json({
        success: false,
        error: 'Failed to fetch pod logs',
        message,
        stderr,
        podName,
      });
    }
  } catch (error) {
    console.error('Pod logs error:', error);
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

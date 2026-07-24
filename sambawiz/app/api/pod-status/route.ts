import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { inferencePodNames } from '@/app/utils/inference-pod-names';

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

interface PodStatus {
  cachePod: { ready: number; total: number; status: string } | null;
  defaultPod: { ready: number; total: number; status: string } | null;
}

/**
 * GET - Fetch pod status for a model deployment
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const deploymentName = searchParams.get('deploymentName');

    if (!deploymentName || typeof deploymentName !== 'string') {
      return NextResponse.json(
        { error: 'Deployment name is required' },
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

    // The inference operator truncates+hashes long deployment names, so we
    // can't assume the pod is literally `inf-<deploymentName>-...`. Derive the
    // exact pod names the operator would create and match on them. Computed up
    // front so they can be returned even when kubectl fails or no pods exist yet.
    const podNames = inferencePodNames(deploymentName);

    try {
      // Run kubectl get pods and filter for the deployment name in JS.
      // Piping to `grep` would make the whole command exit non-zero (throw)
      // when no pods match, making "no pods running" indistinguishable from a
      // real kubectl/auth failure. Filtering here lets us treat an empty match
      // as a valid "nothing running yet" result and reserve errors for actual
      // command failures.
      const output = execSync(`kubectl -n ${namespace} get pods`, {
        encoding: 'utf-8',
        env,
        timeout: 10000, // 10 second timeout
      });

      // Parse the output to extract pod status
      const lines = output.trim().split('\n');
      const podStatus: PodStatus = {
        cachePod: null,
        defaultPod: null,
      };

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;

        const podName = parts[0];
        const readyStatus = parts[1]; // e.g., "1/1" or "1/2"
        const status = parts[2]; // e.g., "Running"

        // Parse ready status
        const [ready, total] = readyStatus.split('/').map(Number);

        // Match against the operator-derived names rather than a substring of
        // the deployment name, which breaks when the name is truncated+hashed.
        if (podName === podNames.cache) {
          podStatus.cachePod = { ready, total, status };
        } else if (podName === podNames.default) {
          podStatus.defaultPod = { ready, total, status };
        }
      }

      return NextResponse.json({
        success: true,
        podStatus,
        podNames,
        deploymentName,
      });
    } catch (error) {
      // Pods might not exist yet or kubectl command failed
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';
      return NextResponse.json({
        success: false,
        error: 'Failed to fetch pod status',
        message,
        stderr,
        podNames,
        deploymentName,
      });
    }
  } catch (error) {
    console.error('Pod status error:', error);
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

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
  checkpointsDir: string;
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

/**
 * GET - Fetch SambaStack installer logs
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lines = searchParams.get('lines') || '20';

    // Read app-config.json to get current kubeconfig
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
      // Run kubectl logs with label selector in sambastack-installer namespace
      console.log('Using kubeconfig:', kubeconfigPath);
      const output = execSync(
        `kubectl -n sambastack-installer logs -l sambanova.ai/app=sambastack-installer --tail=${lines}`,
        {
          encoding: 'utf-8',
          env,
          timeout: 10000, // 10 second timeout
        }
      );

      return NextResponse.json({
        success: true,
        logs: output,
      });
    } catch (error) {
      // Installer might not exist yet or kubectl command failed
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';

      // If the namespace doesn't exist yet, return a friendly message
      if (stderr.includes('NotFound') || stderr.includes('No resources found')) {
        return NextResponse.json({
          success: true,
          logs: 'Waiting for installer to start...',
        });
      }

      return NextResponse.json({
        success: false,
        error: 'Failed to fetch installer logs',
        message,
        stderr,
      });
    }
  } catch (error) {
    console.error('Installer logs error:', error);
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

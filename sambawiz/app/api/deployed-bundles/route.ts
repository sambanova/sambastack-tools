import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import yaml from 'js-yaml';

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

export async function GET() {
  try {
    const configPath = path.join(process.cwd(), 'app-config.json');
    if (!existsSync(configPath)) {
      return NextResponse.json(
        { success: false, error: 'app-config.json not found. Please configure an environment first.' },
        { status: 400 }
      );
    }

    const config: AppConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    const currentEnv = config.currentKubeconfig;
    if (!currentEnv || !config.kubeconfigs[currentEnv]) {
      return NextResponse.json(
        { success: false, error: 'No active environment configured. Please select an environment first.' },
        { status: 400 }
      );
    }

    const kubeconfigFile = config.kubeconfigs[currentEnv].file;
    const namespace = config.kubeconfigs[currentEnv].namespace || 'default';
    const kubeconfigPath = path.join(process.cwd(), kubeconfigFile);

    if (!existsSync(kubeconfigPath)) {
      return NextResponse.json(
        { success: false, error: `Kubeconfig file not found: ${kubeconfigFile}` },
        { status: 400 }
      );
    }

    const env = { ...process.env, KUBECONFIG: kubeconfigPath };

    const output = execSync(`kubectl -n ${namespace} get bundles -o yaml`, {
      encoding: 'utf-8',
      env,
      timeout: 30000,
    });

    const parsed = yaml.load(output) as { items?: Array<{ metadata: { name: string } }> };
    const bundles = (parsed?.items || []).map((item) => item.metadata.name);

    return NextResponse.json({ success: true, bundles });

  } catch (error) {
    console.error('Error fetching deployed bundles:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch deployed bundles'
    }, { status: 500 });
  }
}

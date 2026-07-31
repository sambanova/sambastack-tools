import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import yaml from 'js-yaml';
import { parseModelBundleYamlContent } from '@/app/utils/parse-bundle-yaml';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

interface ModelBundleResource {
  metadata?: {
    name?: string;
    annotations?: Record<string, unknown>;
    labels?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function GET(request: NextRequest) {
  try {
    const bundleName = request.nextUrl.searchParams.get('bundleName');
    if (!bundleName) {
      return NextResponse.json(
        { success: false, error: 'bundleName parameter is required' },
        { status: 400 }
      );
    }

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

    // Get the ModelBundle YAML. A ModelBundle is self-contained — it
    // references ModelProfile/Model CRs by name but doesn't need them
    // fetched to be parsed (profiles/models already exist in the cluster
    // and aren't shown in the builder), so unlike the old Bundle+BundleTemplate
    // flow there's no second kubectl call chasing spec.template.
    const modelBundleYamlStr = execSync(
      `kubectl -n ${namespace} get modelbundle.sambanova.ai ${bundleName} -o yaml`,
      { encoding: 'utf-8', env, timeout: 30000 }
    );

    const modelBundleDoc = yaml.load(modelBundleYamlStr) as ModelBundleResource;

    // Remove metadata.annotations and metadata.labels
    if (modelBundleDoc.metadata?.annotations) {
      delete modelBundleDoc.metadata.annotations;
    }
    if (modelBundleDoc.metadata?.labels) {
      delete modelBundleDoc.metadata.labels;
    }

    const modelBundleClean = yaml.dump(modelBundleDoc);

    // Parse using the same logic as saved artifacts
    const result = parseModelBundleYamlContent(modelBundleClean);
    if ('error' in result) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, ...result });

  } catch (error) {
    console.error('Error loading deployed bundle:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load deployed bundle'
    }, { status: 500 });
  }
}

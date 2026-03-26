import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import yaml from 'js-yaml';
import { parseBundleYamlContent } from '@/app/utils/parse-bundle-yaml';

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

interface BundleResource {
  metadata?: {
    name?: string;
    annotations?: Record<string, unknown>;
    [key: string]: unknown;
  };
  spec?: {
    template?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface BundleTemplateResource {
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

    // Get the bundle YAML
    const bundleYamlStr = execSync(`kubectl -n ${namespace} get bundle ${bundleName} -o yaml`, {
      encoding: 'utf-8',
      env,
      timeout: 30000,
    });

    const bundleDoc = yaml.load(bundleYamlStr) as BundleResource;

    // Remove metadata.annotations
    if (bundleDoc.metadata?.annotations) {
      delete bundleDoc.metadata.annotations;
    }

    // Extract the BundleTemplate name from spec.template
    const templateName = bundleDoc.spec?.template;
    if (!templateName) {
      return NextResponse.json(
        { success: false, error: 'Bundle does not have a spec.template field' },
        { status: 400 }
      );
    }

    // Get the bundletemplate YAML
    const bundleTemplateYamlStr = execSync(
      `kubectl -n ${namespace} get bundletemplate ${templateName} -o yaml`,
      { encoding: 'utf-8', env, timeout: 30000 }
    );

    const bundleTemplateDoc = yaml.load(bundleTemplateYamlStr) as BundleTemplateResource;

    // Remove metadata.annotations and metadata.labels from bundletemplate
    if (bundleTemplateDoc.metadata?.annotations) {
      delete bundleTemplateDoc.metadata.annotations;
    }
    if (bundleTemplateDoc.metadata?.labels) {
      delete bundleTemplateDoc.metadata.labels;
    }

    // Serialize back to YAML and concatenate: <bundletemplate>\n---\n<bundle>
    const bundleTemplateClean = yaml.dump(bundleTemplateDoc);
    const bundleClean = yaml.dump(bundleDoc);
    const combinedYaml = `${bundleTemplateClean}---\n${bundleClean}`;

    // Parse using the same logic as saved artifacts
    const convert = request.nextUrl.searchParams.get('convert') === 'true';
    const result = parseBundleYamlContent(combinedYaml, { skipUnknownPefs: convert });
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

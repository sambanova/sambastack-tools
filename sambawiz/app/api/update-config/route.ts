import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
  apiDomain?: string;
  uiDomain?: string;
}

interface AppConfig {
  checkpointsDir: string;
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

interface UpdateConfigRequest {
  environment: string;
  namespace: string;
  apiKey?: string;
  apiDomain?: string;
  uiDomain?: string;
}

export async function POST(request: Request) {
  try {
    const body: UpdateConfigRequest = await request.json();
    const { environment, namespace, apiKey, apiDomain, uiDomain } = body;

    if (!environment || !namespace) {
      return NextResponse.json({
        success: false,
        error: 'Missing required fields: environment and namespace'
      }, { status: 400 });
    }

    // Read existing config
    const configPath = path.join(process.cwd(), 'app-config.json');
    let config: AppConfig;

    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(configContent);
    } else {
      // Initialize with default values if config doesn't exist
      config = {
        checkpointsDir: '',
        currentKubeconfig: environment,
        kubeconfigs: {}
      };
    }

    // Check if the environment exists in kubeconfigs
    if (!config.kubeconfigs[environment]) {
      return NextResponse.json({
        success: false,
        error: `Environment '${environment}' not found in configuration`
      }, { status: 404 });
    }

    // Verify the kubeconfig file exists
    const kubeconfigFile = config.kubeconfigs[environment].file;
    const kubeconfigPath = path.join(process.cwd(), kubeconfigFile);
    if (!fs.existsSync(kubeconfigPath)) {
      return NextResponse.json({
        success: false,
        error: `Kubeconfig file not found: ${kubeconfigFile}`
      }, { status: 404 });
    }

    // Temporarily update config to match the target environment for PEF generation
    const originalKubeconfig = config.currentKubeconfig;
    const originalNamespace = config.kubeconfigs[environment].namespace;

    config.currentKubeconfig = environment;
    config.kubeconfigs[environment].namespace = namespace;

    // Write temporary config to disk for PEF generator to read
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    // Refresh PEF configs BEFORE committing the environment change
    console.log('[Update Config] Refreshing PEF configs for new environment...');
    const { generatePefConfigs } = await import('../../utils/pef-config-generator');
    const pefResult = await generatePefConfigs();

    if (!pefResult.success) {
      // Rollback the temporary config changes
      config.currentKubeconfig = originalKubeconfig;
      config.kubeconfigs[environment].namespace = originalNamespace;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

      console.error('[Update Config] PEF refresh failed, rolling back environment change');
      return NextResponse.json({
        success: false,
        error: pefResult.error || 'Failed to refresh PEF configurations for the selected environment. Please check the kubeconfig and try again.'
      }, { status: 500 });
    }

    // PEF refresh succeeded, now finalize the config update
    console.log(`[Update Config] PEF configs refreshed successfully (${pefResult.count} configs)`);

    // Update current environment and namespace (already done above, but kept for clarity)
    config.currentKubeconfig = environment;
    config.kubeconfigs[environment].namespace = namespace;

    // Update API key if provided
    if (apiKey !== undefined) {
      config.kubeconfigs[environment].apiKey = apiKey;
    }

    // Update API domain if provided
    if (apiDomain !== undefined) {
      config.kubeconfigs[environment].apiDomain = apiDomain;
    }

    // Update UI domain if provided
    if (uiDomain !== undefined) {
      config.kubeconfigs[environment].uiDomain = uiDomain;
    }

    // Write updated config
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Configuration and PEF configs updated successfully',
      pefCount: pefResult.count,
      config: {
        environment,
        namespace,
        apiKey: apiKey !== undefined ? '***' : undefined,
        kubeconfigFile
      }
    });

  } catch (error) {
    console.error('Error updating configuration:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to update configuration'
    }, { status: 500 });
  }
}

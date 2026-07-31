import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  uiDomain?: string;
  apiDomain?: string;
  apiKey?: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

export async function GET() {
  try {
    const configPath = path.join(process.cwd(), 'app-config.json');
    const configExists = fs.existsSync(configPath);

    if (!configExists) {
      return NextResponse.json({
        success: true,
        exists: false,
        valid: false,
        message: 'app-config.json does not exist',
      });
    }

    // Check if the file is valid JSON with the expected shape. Checkpoints are
    // no longer GCS-bucket-rooted (v3: they come from the Model CR), so
    // "valid" just means the config parses and has a kubeconfigs map — an
    // empty kubeconfigs map is still valid (handled separately by the
    // "no kubeconfigs" auto-populate/prompt flow in Home.tsx).
    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config: AppConfig = JSON.parse(configContent);

      const valid = typeof config === 'object' && config !== null && typeof config.kubeconfigs === 'object';

      return NextResponse.json({
        success: true,
        exists: true,
        valid,
        config,
        message: valid ? 'Configuration is valid' : 'app-config.json is missing a "kubeconfigs" object',
      });
    } catch {
      return NextResponse.json({
        success: true,
        exists: true,
        valid: false,
        message: 'app-config.json is not valid JSON',
      });
    }
  } catch (error) {
    console.error('Error checking app-config.json:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to check app-config.json',
    }, { status: 500 });
  }
}

export async function POST() {
  try {
    const configPath = path.join(process.cwd(), 'app-config.json');
    const kubeconfigsDir = path.join(process.cwd(), 'kubeconfigs');

    // Create minimal app-config.json
    const config: AppConfig = {
      currentKubeconfig: '',
      kubeconfigs: {},
    };

    // Check if there are any kubeconfig files in the kubeconfigs directory
    if (fs.existsSync(kubeconfigsDir)) {
      const files = fs.readdirSync(kubeconfigsDir);
      const yamlFiles = files.filter(
        (file) => (file.endsWith('.yaml') || file.endsWith('.yml')) && file !== 'kubeconfig_example.yaml'
      );

      if (yamlFiles.length > 0) {
        // Auto-populate kubeconfigs
        yamlFiles.forEach((file) => {
          const envName = file.replace(/\.(yaml|yml)$/, '');
          config.kubeconfigs[envName] = {
            file: `kubeconfigs/${file}`,
            namespace: 'default',
          };
        });

        // Set the first one as current
        config.currentKubeconfig = yamlFiles[0].replace(/\.(yaml|yml)$/, '');
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: 'app-config.json created successfully',
      config,
    });
  } catch (error) {
    console.error('Error creating app-config.json:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to create app-config.json',
    }, { status: 500 });
  }
}

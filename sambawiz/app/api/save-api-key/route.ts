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
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

interface SaveApiKeyRequest {
  apiKey: string;
}

// Lightweight endpoint to save only the API key for the current environment.
// Unlike /api/update-config, this does not refresh PEF configs or require a
// namespace — it just persists the key so the Playground can keep using it
// without leaving the page.
export async function POST(request: Request) {
  try {
    const body: SaveApiKeyRequest = await request.json();
    const { apiKey } = body;

    if (apiKey === undefined) {
      return NextResponse.json({
        success: false,
        error: 'Missing required field: apiKey'
      }, { status: 400 });
    }

    const configPath = path.join(process.cwd(), 'app-config.json');

    if (!fs.existsSync(configPath)) {
      return NextResponse.json({
        success: false,
        error: 'app-config.json not found'
      }, { status: 404 });
    }

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);

    const environment = config.currentKubeconfig;

    if (!environment || !config.kubeconfigs[environment]) {
      return NextResponse.json({
        success: false,
        error: 'No current environment selected. Please select an environment first.'
      }, { status: 400 });
    }

    config.kubeconfigs[environment].apiKey = apiKey;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'API key saved successfully',
      environment
    });

  } catch (error) {
    console.error('Error saving API key:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to save API key'
    }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
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

export async function POST(request: NextRequest) {
  try {
    const { input, model } = await request.json();

    if (!input || !model) {
      return NextResponse.json({
        success: false,
        error: 'Input and model are required',
      }, { status: 400 });
    }

    const configPath = path.join(process.cwd(), 'app-config.json');

    if (!fs.existsSync(configPath)) {
      return NextResponse.json({
        success: false,
        error: 'app-config.json not found',
      }, { status: 500 });
    }

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);

    const currentEnvironment = config.currentKubeconfig;

    if (!currentEnvironment || !config.kubeconfigs[currentEnvironment]) {
      return NextResponse.json({
        success: false,
        error: `Current environment ${currentEnvironment} not found in app-config.json`,
      }, { status: 500 });
    }

    const environmentConfig = config.kubeconfigs[currentEnvironment];
    const apiKey = environmentConfig.apiKey;
    const apiDomain = environmentConfig.apiDomain;

    if (!apiKey) {
      return NextResponse.json({
        success: false,
        error: `API Key not found in app-config.json for environment ${currentEnvironment}`,
      }, { status: 500 });
    }

    if (!apiDomain) {
      return NextResponse.json({
        success: false,
        error: `API Domain not found in app-config.json for environment ${currentEnvironment}`,
      }, { status: 500 });
    }

    const normalizedApiDomain = apiDomain.endsWith('/') ? apiDomain : `${apiDomain}/`;
    const apiUrl = `${normalizedApiDomain}v1/embeddings`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input, model }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
      if (errorText) {
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error) {
            errorMessage += ` - ${errorJson.error}`;
          } else if (errorJson.message) {
            errorMessage += ` - ${errorJson.message}`;
          } else {
            errorMessage += ` - ${errorText}`;
          }
        } catch {
          errorMessage += ` - ${errorText}`;
        }
      }

      return NextResponse.json({
        success: false,
        error: errorMessage,
      }, { status: response.status });
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding) {
      return NextResponse.json({
        success: false,
        error: 'No embedding returned from the model',
      }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      embedding,
      usage: data.usage,
    });

  } catch (error) {
    console.error('Error in embeddings API:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process embeddings request',
    }, { status: 500 });
  }
}

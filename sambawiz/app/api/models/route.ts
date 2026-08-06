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

/**
 * GET - List the models routable via the current environment's OpenAI-compatible
 * /v1/models endpoint.
 *
 * The Playground uses this as the source of truth for which models can actually
 * be chatted with / embedded. It intentionally does NOT go through the bundle
 * deployment / kubectl: /v1/models already returns only the routable models for
 * the selected Kubeconfig's API domain. Whether a given model is an embedding
 * model is determined separately, client-side, from the local checkpoint_mapping
 * (see IsEmbeddingModelFn in types/bundle.ts) — /v1/models doesn't expose that.
 */
export async function GET() {
  try {
    const configPath = path.join(process.cwd(), 'app-config.json');

    if (!fs.existsSync(configPath)) {
      return NextResponse.json(
        { success: false, error: 'app-config.json not found. Please configure an environment first.' },
        { status: 400 }
      );
    }

    const config: AppConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const currentEnvironment = config.currentKubeconfig;

    if (!currentEnvironment || !config.kubeconfigs[currentEnvironment]) {
      return NextResponse.json(
        { success: false, error: 'No active environment configured. Please select an environment first.' },
        { status: 400 }
      );
    }

    const environmentConfig = config.kubeconfigs[currentEnvironment];
    const apiKey = environmentConfig.apiKey;
    const apiDomain = environmentConfig.apiDomain;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: `API Key not found in app-config.json for environment ${currentEnvironment}` },
        { status: 400 }
      );
    }

    if (!apiDomain) {
      return NextResponse.json(
        { success: false, error: `API Domain not found in app-config.json for environment ${currentEnvironment}` },
        { status: 400 }
      );
    }

    const normalizedApiDomain = apiDomain.endsWith('/') ? apiDomain : `${apiDomain}/`;
    // Append a unique cache-buster query param so the Cloudflare CDN in front of
    // the API doesn't serve a stale /v1/models list — otherwise newly deployed /
    // undeployed models don't show up on Playground refresh.
    const cacheBuster = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const apiUrl = `${normalizedApiDomain}v1/models?cb=${cacheBuster}`;

    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      // Also bypass Next.js's own fetch cache for this request.
      cache: 'no-store',
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
      if (errorText) {
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage += ` - ${errorJson.error || errorJson.message || errorText}`;
        } catch {
          errorMessage += ` - ${errorText}`;
        }
      }
      return NextResponse.json({ success: false, error: errorMessage }, { status: response.status });
    }

    const data: { data?: Array<{ id?: string }> } = await response.json();
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    return NextResponse.json({ success: true, models });
  } catch (error) {
    console.error('Error in models API:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch models',
      },
      { status: 500 }
    );
  }
}

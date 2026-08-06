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
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

/**
 * POST - Transcribe an audio clip with an ASR model (e.g. Whisper-Large-v3) via
 * the current environment's OpenAI-compatible `/v1/audio/transcriptions`
 * endpoint.
 *
 * Accepts a `multipart/form-data` body with:
 *   - `file`  (required): the audio blob (webm/wav/mp3/… up to 25 MB)
 *   - `model` (required): the ASR model id
 *   - `language`, `prompt`, `response_format` (optional): forwarded as-is
 *
 * The upstream endpoint itself expects multipart/form-data, so the file is
 * streamed straight through rather than JSON-encoded.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    const model = form.get('model');

    if (!(file instanceof Blob) || !model || typeof model !== 'string') {
      return NextResponse.json(
        { success: false, error: 'An audio file and model are required' },
        { status: 400 }
      );
    }

    const configPath = path.join(process.cwd(), 'app-config.json');

    if (!fs.existsSync(configPath)) {
      return NextResponse.json({ success: false, error: 'app-config.json not found' }, { status: 500 });
    }

    const config: AppConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const currentEnvironment = config.currentKubeconfig;

    if (!currentEnvironment || !config.kubeconfigs[currentEnvironment]) {
      return NextResponse.json(
        { success: false, error: `Current environment ${currentEnvironment} not found in app-config.json` },
        { status: 500 }
      );
    }

    const environmentConfig = config.kubeconfigs[currentEnvironment];
    const apiKey = environmentConfig.apiKey;
    const apiDomain = environmentConfig.apiDomain;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: `API Key not found in app-config.json for environment ${currentEnvironment}` },
        { status: 500 }
      );
    }

    if (!apiDomain) {
      return NextResponse.json(
        { success: false, error: `API Domain not found in app-config.json for environment ${currentEnvironment}` },
        { status: 500 }
      );
    }

    const normalizedApiDomain = apiDomain.endsWith('/') ? apiDomain : `${apiDomain}/`;
    const apiUrl = `${normalizedApiDomain}v1/audio/transcriptions`;

    // Rebuild the multipart body to forward upstream. A recorded clip arrives as
    // a nameless Blob, so give it a filename with an extension the API accepts.
    const fileName = (file instanceof File && file.name) ? file.name : 'recording.webm';
    const upstreamForm = new FormData();
    upstreamForm.append('file', file, fileName);
    upstreamForm.append('model', model);
    for (const key of ['language', 'prompt', 'response_format'] as const) {
      const value = form.get(key);
      if (typeof value === 'string' && value.length > 0) {
        upstreamForm.append(key, value);
      }
    }

    // NOTE: do not set Content-Type manually — fetch adds the multipart boundary.
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
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

    // response_format defaults to json ({ text }); `text` returns a bare string.
    const contentType = response.headers.get('content-type') || '';
    let text: string;
    if (contentType.includes('application/json')) {
      const data = await response.json();
      text = data.text ?? '';
    } else {
      text = (await response.text()).trim();
    }

    if (!text) {
      return NextResponse.json(
        { success: false, error: 'No transcription returned from the model' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, text });
  } catch (error) {
    console.error('Error in transcribe API:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to process transcription request' },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { floatPcmToWav, extractErrorMessage, parseSpeechStream } from '../../utils/speech';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
  apiDomain?: string;
  uiDomain?: string;
  // Optional override for the model id sent to /v1/audio/speech. The routable id
  // exposed by /v1/models (e.g. "qwen3-tts-talker") can differ from the model
  // the speech handler is configured to accept (the spec example uses
  // "qwen3-tts"); set this per-environment to reconcile that mismatch without a
  // code change.
  ttsModel?: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
  // Global fallback for the /v1/audio/speech model id (per-env `ttsModel` wins).
  ttsModel?: string;
}

/**
 * POST - Synthesize speech from text with the qwen3-tts model via the current
 * environment's `/v1/audio/speech` endpoint.
 *
 * Accepts JSON `{ input, model, voice, language? }`. The upstream endpoint
 * responds with an SSE stream of base64 float32-PCM chunks; we aggregate them,
 * wrap the PCM in a WAV container, and return it as a base64 `data:` URL so the
 * Playground can play the whole clip in one <audio> element.
 *
 * NOTE: the TTS spec's example uses `model: "qwen3-tts"`, but the routable id
 * exposed by /v1/models is the deployed model name (e.g. "qwen3-tts-talker"),
 * so we forward the caller-supplied model rather than a hardcoded constant.
 */
export async function POST(request: NextRequest) {
  try {
    const { input, model, voice, language } = await request.json();

    if (!input || !model || !voice) {
      return NextResponse.json(
        { success: false, error: 'Input text, model, and voice are required' },
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
    const apiUrl = `${normalizedApiDomain}v1/audio/speech`;

    // If the routable model id differs from what the speech handler accepts, an
    // app-config `ttsModel` override (per-env, else global) takes precedence.
    const speechModel = environmentConfig.ttsModel || config.ttsModel || model;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: speechModel,
        input,
        voice,
        ...(language ? { language } : {}),
      }),
    });

    // Errors before the SSE stream opens arrive as a non-2xx status with an
    // { error: { message } } body (JSON or an SSE `data:` line).
    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
      const parsed = extractErrorMessage(errorText);
      if (parsed) errorMessage += ` - ${parsed}`;
      else if (errorText) errorMessage += ` - ${errorText}`;
      return NextResponse.json({ success: false, error: errorMessage }, { status: response.status });
    }

    // Aggregate the SSE stream: one `data:` line per chunk, ending with [DONE].
    const { pcmChunks, streamError } = parseSpeechStream(await response.text());

    if (streamError && pcmChunks.length === 0) {
      return NextResponse.json({ success: false, error: streamError }, { status: 502 });
    }

    if (pcmChunks.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No audio returned from the model' },
        { status: 500 }
      );
    }

    const sampleRate = parseInt(response.headers.get('x-audio-sample-rate') || '24000', 10);
    const channels = parseInt(response.headers.get('x-audio-channels') || '1', 10);
    const wav = floatPcmToWav(Buffer.concat(pcmChunks), sampleRate, channels);
    const audio = `data:audio/wav;base64,${wav.toString('base64')}`;

    return NextResponse.json({ success: true, audio, contentType: 'audio/wav' });
  } catch (error) {
    console.error('Error in speech API:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to process speech request' },
      { status: 500 }
    );
  }
}

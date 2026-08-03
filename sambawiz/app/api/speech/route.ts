import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

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
 * Build a mono 16-bit PCM WAV file from raw float32 little-endian PCM samples.
 *
 * The TTS endpoint streams float32 PCM (X-Audio-Format: f32le), which browsers
 * can't play directly, so we down-convert to int16 and prepend a WAV header —
 * the most broadly-supported format for an <audio> element.
 */
function floatPcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const floatCount = Math.floor(pcm.length / 4);
  const dataLength = floatCount * 2; // 16-bit samples
  const buffer = Buffer.alloc(44 + dataLength);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buffer.writeUInt16LE(channels * 2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  for (let i = 0; i < floatCount; i++) {
    // Clamp [-1, 1] float → int16.
    const sample = Math.max(-1, Math.min(1, pcm.readFloatLE(i * 4)));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buffer;
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
    const raw = await response.text();
    const pcmChunks: Buffer[] = [];
    let streamError: string | null = null;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') break;

      let event: {
        audio_b64?: string;
        finish_reason?: string | null;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue; // ignore keep-alives / malformed lines
      }

      // Mid-stream error event (status is already 200, so it comes as data).
      if (event.error || event.finish_reason === 'error') {
        streamError = event.error?.message || 'TTS generation failed mid-stream';
        break;
      }
      if (event.audio_b64) {
        pcmChunks.push(Buffer.from(event.audio_b64, 'base64'));
      }
    }

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

/** Pull a human-readable message out of an error body (plain JSON or `data:` SSE line). */
function extractErrorMessage(body: string): string | null {
  if (!body) return null;
  const candidates = [body, ...body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())];
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      if (json?.error?.message) return json.error.message;
      if (json?.message) return json.message;
    } catch {
      // not JSON — try the next candidate
    }
  }
  return null;
}

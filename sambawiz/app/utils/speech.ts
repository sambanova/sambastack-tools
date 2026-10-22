/**
 * Shared TTS helpers used by both the /api/speech route and the CLI `speak` command.
 */

/**
 * Build a mono 16-bit PCM WAV file from raw float32 little-endian PCM samples.
 *
 * The TTS endpoint streams float32 PCM (X-Audio-Format: f32le), which browsers
 * can't play directly, so we down-convert to int16 and prepend a WAV header —
 * the most broadly-supported format for an <audio> element.
 */
export function floatPcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
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

/** Pull a human-readable message out of an error body (plain JSON or `data:` SSE line). */
export function extractErrorMessage(body: string): string | null {
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

/**
 * Aggregates the `/v1/audio/speech` SSE body: one `data:` line per chunk, ending with [DONE].
 * A mid-stream error event (status is already 200) is returned as `streamError`.
 */
export function parseSpeechStream(raw: string): { pcmChunks: Buffer[]; streamError: string | null } {
  const pcmChunks: Buffer[] = [];
  let streamError: string | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') break;

    let event: { audio_b64?: string; finish_reason?: string | null; error?: { message?: string } };
    try {
      event = JSON.parse(payload);
    } catch {
      continue; // ignore keep-alives / malformed lines
    }

    if (event.error || event.finish_reason === 'error') {
      streamError = event.error?.message || 'TTS generation failed mid-stream';
      break;
    }
    if (event.audio_b64) pcmChunks.push(Buffer.from(event.audio_b64, 'base64'));
  }
  return { pcmChunks, streamError };
}

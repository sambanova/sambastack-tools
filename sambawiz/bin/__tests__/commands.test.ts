/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseModelSpec, parseBatchSpec, buildSelections } from '../commands';
import type { CheckpointMappingV3, ModelProfilesCache } from '../../app/types/bundle';

const mapping: CheckpointMappingV3 = {
  Llama: { resource_name: 'llama', capabilities: [], checkpoints: { a1: { versions: { '1': { checkpoint_status: 'ok' } } } } },
  Multi: { resource_name: 'multi', capabilities: [], checkpoints: { a1: { versions: { '1': {} } }, a2: { versions: { '1': {} } } } },
} as any;
const profiles: ModelProfilesCache = {
  p1: { model_arch: 'a1', features: [], batchingConfigs: { all: { '32k': { batch_sizes: [1, 2, 4] } }, recommended: { '32k': { batch_sizes: [1] } } } },
  cache: { model_arch: 'a2', features: ['prompt_caching'], batchingConfigs: { all: { '8k': { batch_sizes: [1] } } } },
} as any;

describe('spec parsing', () => {
  it('parses --model and --batch', () => {
    expect(parseModelSpec('Llama:p1')).toEqual({ model: 'Llama', profile: 'p1', arch: undefined });
    expect(parseModelSpec('Llama:p1:a1').arch).toBe('a1');
    expect(parseBatchSpec('Llama:32k=1,2')).toEqual({ model: 'Llama', tier: '32k', sizes: [1, 2] });
    expect(parseBatchSpec('Llama:32k=*').sizes).toBe('*');
  });
  it('rejects malformed specs', () => {
    expect(() => parseModelSpec('Llama')).toThrow(/Invalid --model/);
    expect(() => parseBatchSpec('Llama:32k')).toThrow(/Invalid --batch/);
    expect(() => parseBatchSpec('Llama:32k=a')).toThrow(/Invalid batch sizes/);
  });
});

describe('buildSelections', () => {
  it('resolves model/profile and applies a batch override within the universe', () => {
    const [s] = buildSelections({ models: ['llama:P1'], batch: ['Llama:32k=1,2'] }, mapping, profiles);
    expect(s.model.metadata.name).toBe('llama');
    expect(s.batchingConfigOverride!['32k'].batch_sizes).toEqual([1, 2]);
  });
  it('rejects sizes/contexts outside the profile universe, unknown models and profiles', () => {
    expect(() => buildSelections({ models: ['Llama:p1'], batch: ['Llama:32k=8'] }, mapping, profiles)).toThrow(/not supported/);
    expect(() => buildSelections({ models: ['Llama:p1'], batch: ['Llama:64k=1'] }, mapping, profiles)).toThrow(/not in this profile/);
    expect(() => buildSelections({ models: ['Nope:p1'] }, mapping, profiles)).toThrow(/Unknown model/);
    expect(() => buildSelections({ models: ['Llama:zzz'] }, mapping, profiles)).toThrow(/Unknown profile/);
  });
  it('requires an arch for multi-arch models and blocks multi-model prompt caching', () => {
    expect(() => buildSelections({ models: ['Multi:p1'] }, mapping, profiles)).toThrow(/several archs/);
    expect(() => buildSelections({ models: ['Multi:cache:a2', 'Llama:p1'] }, mapping, profiles)).toThrow(/single-model/);
  });
});

import { apiBase, installComplete, imageDataUrl } from '../commands';
import { floatPcmToWav, parseSpeechStream, extractErrorMessage } from '../../app/utils/speech';
describe('api + install helpers', () => {
  it('normalises the API base like the Playground', () => {
    expect(apiBase('https://x.net')).toBe('https://x.net/');
    expect(apiBase('https://x.net/v1/chat/completions')).toBe('https://x.net/');
  });
  it('detects installer completion for 1.x and 2.x', () => {
    expect(installComplete(['a', 'run configure_default_ingress'])).toBe(true);
    expect(installComplete(['create_keycloak_user: user already exists', 'tail'])).toBe(true);
    expect(installComplete(['still working'])).toBe(false);
  });
});

describe('image + speech helpers', () => {
  it('rejects unsupported or missing images', () => {
    expect(() => imageDataUrl('x.bmp')).toThrow(/Unsupported image type/);
    expect(() => imageDataUrl('/nonexistent/a.png')).toThrow(/not found/);
  });
  it('builds a WAV and aggregates SSE chunks like the UI route', () => {
    const f32 = Buffer.alloc(8); f32.writeFloatLE(0.5, 0); f32.writeFloatLE(-0.5, 4);
    const sse = `data: ${JSON.stringify({ audio_b64: f32.toString('base64') })}\n\ndata: [DONE]\n`;
    const { pcmChunks, streamError } = parseSpeechStream(sse);
    expect(streamError).toBeNull();
    const wav = floatPcmToWav(Buffer.concat(pcmChunks), 24000, 1);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readInt16LE(44)).toBe(16384);
    expect(parseSpeechStream('data: {"error":{"message":"boom"}}\n').streamError).toBe('boom');
    expect(extractErrorMessage('data: {"error":{"message":"m"}}')).toBe('m');
  });
});

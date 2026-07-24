/**
 * @jest-environment node
 */
import { POST } from './route';
import { execSync } from 'child_process';
import { promises as fsPromises } from 'fs';

// Mock fs (route uses the promise-based API)
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
  },
}));

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

describe('generate-model-profiles route', () => {
  const mockAppConfig = {
    currentKubeconfig: 'dev',
    kubeconfigs: {
      dev: {
        file: 'kubeconfigs/dev.yaml',
        namespace: 'default',
      },
    },
  };

  const mockProfilesOutput = {
    items: [
      {
        metadata: { name: 'llama-profile-hi' },
        spec: {
          model_arch: 'llama-arch-a',
          features: [],
          defaultBatchingConfig: {
            '8k': { batch_sizes: [1, 2, 4] },
          },
          pefs: ['llama-pef:1'],
        },
        status: {
          batchingConfig: { '8k': { batch_sizes: [1] } },
        },
      },
      {
        metadata: { name: 'llama-profile-ht' },
        spec: {
          model_arch: 'llama-arch-a',
          features: ['continuous_batching'],
          // No defaultBatchingConfig - should fall back to status.batchingConfig
          pefs: ['llama-pef-ht:1'],
        },
        status: {
          batchingConfig: { '32k': { batch_sizes: '*' } },
        },
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (fsPromises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockAppConfig));
    (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
    (execSync as jest.Mock).mockReturnValue(JSON.stringify(mockProfilesOutput));
  });

  it('uses spec.defaultBatchingConfig when present', async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);

    expect(written['llama-profile-hi'].batchingConfig).toEqual({
      '8k': { batch_sizes: [1, 2, 4] },
    });
  });

  it('falls back to status.batchingConfig when defaultBatchingConfig is absent', async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);

    expect(written['llama-profile-ht'].batchingConfig).toEqual({
      '32k': { batch_sizes: '*' },
    });
  });

  it('defaults batchingConfig to {} when neither defaultBatchingConfig nor status.batchingConfig exist', async () => {
    (execSync as jest.Mock).mockReturnValue(JSON.stringify({
      items: [
        {
          metadata: { name: 'bare-profile' },
          spec: { model_arch: 'arch-x', features: [], pefs: [] },
        },
      ],
    }));

    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);

    expect(written['bare-profile'].batchingConfig).toEqual({});
    expect(written['bare-profile'].features).toEqual([]);
    expect(written['bare-profile'].pefs).toEqual([]);
  });

  it('writes the ModelProfilesCache shape ({ model_arch, features, batchingConfig, pefs }) for each profile', async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    expect(writeCall[0]).toContain('model_profiles.json');
    const written = JSON.parse(writeCall[1]);

    expect(written['llama-profile-hi']).toEqual({
      model_arch: 'llama-arch-a',
      features: [],
      batchingConfig: { '8k': { batch_sizes: [1, 2, 4] } },
      pefs: ['llama-pef:1'],
    });

    expect(written['llama-profile-ht']).toEqual({
      model_arch: 'llama-arch-a',
      features: ['continuous_batching'],
      batchingConfig: { '32k': { batch_sizes: '*' } },
      pefs: ['llama-pef-ht:1'],
    });
  });

  it('skips profiles missing metadata.name or spec.model_arch', async () => {
    (execSync as jest.Mock).mockReturnValue(JSON.stringify({
      items: [
        { metadata: {}, spec: { model_arch: 'arch-a' } },
        { metadata: { name: 'no-arch' }, spec: {} },
      ],
    }));

    const response = await POST();
    const body = await response.json();

    expect(body.count).toBe(0);
  });

  it('calls kubectl get modelprofiles with the correct namespace and kubeconfig', async () => {
    await POST();

    expect(execSync).toHaveBeenCalledWith(
      'kubectl -n default get modelprofiles -o json',
      expect.objectContaining({
        encoding: 'utf-8',
        env: expect.objectContaining({
          KUBECONFIG: expect.stringContaining('kubeconfigs/dev.yaml'),
        }),
      })
    );
  });

  it('returns success with the correct profile count', async () => {
    const response = await POST();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
  });

  it('returns 400 when no kubeconfig file is configured (no active environment)', async () => {
    (fsPromises.readFile as jest.Mock).mockResolvedValue(JSON.stringify({
      ...mockAppConfig,
      currentKubeconfig: '',
    }));

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('No kubeconfig file configured');
  });

  it('returns 500 when app-config.json cannot be read (not found)', async () => {
    (fsPromises.readFile as jest.Mock).mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to generate model profiles');
  });

  it('returns 500 when kubectl fails', async () => {
    (execSync as jest.Mock).mockImplementation(() => {
      throw new Error('kubectl command failed');
    });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
  });

  it('returns a clear 400 (not a 500) when the backend has no ModelProfile CRD (v2-only backend)', async () => {
    (execSync as jest.Mock).mockImplementation(() => {
      const err = new Error('Command failed: kubectl -n default get modelprofiles -o json') as Error & { stderr?: string };
      err.stderr = 'error: the server doesn\'t have a resource type "modelprofiles"';
      throw err;
    });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('does not support v3 bundles');
    expect(body.error).toContain('ModelProfile');
  });
});

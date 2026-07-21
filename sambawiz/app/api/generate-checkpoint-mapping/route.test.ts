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

// The route re-runs PEF config generation after writing the checkpoint
// mapping; that logic is already covered end-to-end by
// app/utils/__tests__/pef-config-generator.test.ts, so it's mocked out here
// to keep this suite focused on the checkpoint-mapping-specific behavior.
jest.mock('../../utils/pef-config-generator', () => ({
  generatePefConfigs: jest.fn().mockResolvedValue({ success: true, count: 0 }),
}));

describe('generate-checkpoint-mapping route', () => {
  const mockAppConfig = {
    checkpointsDir: 'gs://my-bucket/',
    currentKubeconfig: 'dev',
    kubeconfigs: {
      dev: {
        file: 'kubeconfigs/dev.yaml',
        namespace: 'default',
      },
    },
  };

  const mockModelsOutput = {
    items: [
      {
        metadata: { name: 'meta-llama-3-1-8b-instruct' },
        spec: {
          name: 'Meta-Llama-3.1-8B-Instruct',
          checkpoints: {
            'llama-arch-a': {
              versions: {
                '1': {
                  source: 'gs://my-bucket/checkpoints/llama/arch-a/v1/',
                  checkpoint_status: 'stable',
                },
              },
            },
            'llama-arch-b': {
              versions: {
                '1': {
                  source: 'gs://my-bucket/checkpoints/llama/arch-b/v1/',
                  checkpoint_status: 'preview',
                  tool_support: true,
                  vision_embedding_checkpoint: 'gs://my-bucket/checkpoints/llama/arch-b/vision/',
                },
              },
            },
          },
          metadata: {
            capabilities: ['text', 'embeddings'],
          },
        },
      },
      {
        metadata: { name: 'single-arch-model' },
        spec: {
          name: 'Single-Arch-Model',
          checkpoints: {
            'only-arch': {
              versions: {
                '1': { source: 'gs://my-bucket/checkpoints/single/v1/' },
              },
            },
          },
          metadata: { capabilities: [] },
        },
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (fsPromises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockAppConfig));
    (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
    (execSync as jest.Mock).mockReturnValue(JSON.stringify(mockModelsOutput));
  });

  it('captures ALL checkpoint archs for a multi-arch model, not just the first', async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    expect(writeCall[0]).toContain('checkpoint_mapping.json');
    const written = JSON.parse(writeCall[1]);

    const archs = written['Meta-Llama-3.1-8B-Instruct'].checkpoints;
    expect(Object.keys(archs)).toEqual(['llama-arch-a', 'llama-arch-b']);
  });

  it("preserves each arch's version data (checkpoint_status, tool_support, vision_embedding_checkpoint)", async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);
    const archs = written['Meta-Llama-3.1-8B-Instruct'].checkpoints;

    expect(archs['llama-arch-a'].versions['1']).toEqual({
      source: 'checkpoints/llama/arch-a/v1',
      checkpoint_status: 'stable',
    });

    expect(archs['llama-arch-b'].versions['1']).toEqual({
      source: 'checkpoints/llama/arch-b/v1',
      checkpoint_status: 'preview',
      tool_support: true,
      vision_embedding_checkpoint: 'checkpoints/llama/arch-b/vision',
    });
  });

  it('captures spec.metadata.capabilities, including "embeddings"', async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);

    expect(written['Meta-Llama-3.1-8B-Instruct'].capabilities).toEqual(['text', 'embeddings']);
  });

  it('strips the gs://bucket/ prefix and trailing slash from source paths', async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);
    const source = written['Meta-Llama-3.1-8B-Instruct'].checkpoints['llama-arch-a'].versions['1'].source;

    expect(source).toBe('checkpoints/llama/arch-a/v1');
    expect(source.startsWith('gs://')).toBe(false);
    expect(source.endsWith('/')).toBe(false);
  });

  it('handles a model with only a single checkpoint arch', async () => {
    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);
    const entry = written['Single-Arch-Model'];

    expect(Object.keys(entry.checkpoints)).toEqual(['only-arch']);
    expect(entry.checkpoints['only-arch'].versions['1'].source).toBe('checkpoints/single/v1');
    expect(entry.capabilities).toEqual([]);
  });

  it('skips checkpoint archs with no valid versions', async () => {
    (execSync as jest.Mock).mockReturnValue(JSON.stringify({
      items: [
        {
          metadata: { name: 'model-x' },
          spec: {
            name: 'Model-X',
            checkpoints: {
              'empty-arch': { versions: {} },
              'good-arch': { versions: { '1': { source: 'gs://my-bucket/checkpoints/x/v1/' } } },
            },
            metadata: { capabilities: [] },
          },
        },
      ],
    }));

    await POST();

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    const written = JSON.parse(writeCall[1]);

    expect(Object.keys(written['Model-X'].checkpoints)).toEqual(['good-arch']);
  });

  it('skips models missing spec.name, metadata.name, or checkpoints', async () => {
    (execSync as jest.Mock).mockReturnValue(JSON.stringify({
      items: [
        {
          metadata: { name: 'no-display-name' },
          spec: { name: '', checkpoints: { a: { versions: { '1': { source: 'gs://b/x/' } } } }, metadata: {} },
        },
      ],
    }));

    const response = await POST();
    const body = await response.json();

    expect(body.count).toBe(0);
  });

  it('returns success with the model count', async () => {
    const response = await POST();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
  });

  it('calls kubectl get models with the correct namespace and kubeconfig', async () => {
    await POST();

    expect(execSync).toHaveBeenCalledWith(
      'kubectl -n default get models -o json',
      expect.objectContaining({
        encoding: 'utf-8',
        env: expect.objectContaining({
          KUBECONFIG: expect.stringContaining('kubeconfigs/dev.yaml'),
        }),
      })
    );
  });

  it('re-runs PEF config generation after writing the checkpoint mapping', async () => {
    const { generatePefConfigs } = await import('../../utils/pef-config-generator');

    await POST();

    expect(generatePefConfigs).toHaveBeenCalled();
  });

  it('returns 400 when no kubeconfig file is configured', async () => {
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

  it('returns 500 when app-config.json cannot be read', async () => {
    (fsPromises.readFile as jest.Mock).mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to generate checkpoint mapping');
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
});

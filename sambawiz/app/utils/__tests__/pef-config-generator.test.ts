import { generatePefConfigs } from '../pef-config-generator';
import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';

// Mock fs module
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

describe('pef-config-generator', () => {
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

  const mockKubectlOutput = {
    items: [
      {
        metadata: { name: 'llama-3p1-70b-ss4096-bs1-sd9' },
        spec: {
          versions: {
            '1': {},
            '2': {},
            '3': {},
          },
        },
      },
      {
        metadata: { name: 'qwen2-5-72b-ss2048-bs16' },
        spec: {
          versions: {
            '1': {},
          },
        },
      },
      {
        metadata: { name: 'model-ss512-bs8' },
        spec: {
          versions: {
            '5': {},
            '10': {},
          },
        },
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock existsSync to return true for all file checks (app-config.json and kubeconfig files)
    (existsSync as jest.Mock).mockImplementation(() => true);
    (readFileSync as jest.Mock).mockImplementation((filePath: string) => {
      if (String(filePath).includes('pef_mapping.json')) {
        return JSON.stringify({});
      }
      return JSON.stringify(mockAppConfig);
    });
    (execSync as jest.Mock).mockReturnValue(JSON.stringify(mockKubectlOutput));
    // Reset writeFileSync to default mock (no-op)
    (writeFileSync as jest.Mock).mockImplementation(() => undefined);
  });

  describe('generatePefConfigs', () => {
    it('should return error when app-config.json does not exist', async () => {
      (existsSync as jest.Mock).mockReturnValue(false);

      const result = await generatePefConfigs();

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    });

    it('should return error when no active environment is configured', async () => {
      const configWithoutEnv = {
        ...mockAppConfig,
        currentKubeconfig: '',
      };
      (readFileSync as jest.Mock).mockReturnValue(JSON.stringify(configWithoutEnv));

      const result = await generatePefConfigs();

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    });

    it('should return error when kubeconfig file does not exist', async () => {
      (existsSync as jest.Mock)
        .mockReturnValueOnce(true) // app-config.json exists
        .mockReturnValueOnce(false); // kubeconfig file does not exist

      const result = await generatePefConfigs();

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    });

    it('should return error with specific message when pef_mapping.json does not exist', async () => {
      (existsSync as jest.Mock).mockImplementation((filePath: string) => {
        return !String(filePath).includes('pef_mapping.json');
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(
          'pef_mapping.json was not found in the app/data folder! Please restore the file and reapply the environment configuration.'
        );
      }
    });

    it('should call kubectl with correct parameters', async () => {
      await generatePefConfigs();

      expect(execSync).toHaveBeenCalledWith(
        'kubectl -n default get pef -o json',
        expect.objectContaining({
          encoding: 'utf-8',
          env: expect.objectContaining({
            KUBECONFIG: expect.stringContaining('kubeconfigs/dev.yaml'),
          }),
        })
      );
    });

    it('should parse PEF names correctly', async () => {
      const result = await generatePefConfigs();

      expect(result.success).toBe(true);
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('pef_configs.json'),
        expect.stringContaining('llama-3p1-70b-ss4096-bs1-sd9'),
        'utf-8'
      );
    });

    it('should extract ss and bs values correctly', async () => {
      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      expect(writtenData['llama-3p1-70b-ss4096-bs1-sd9']).toEqual({
        ss: '4k',
        bs: '1',
        latestVersion: '3',
      });

      expect(writtenData['qwen2-5-72b-ss2048-bs16']).toEqual({
        ss: '2k',
        bs: '16',
        latestVersion: '1',
      });

      expect(writtenData['model-ss512-bs8']).toEqual({
        ss: '512',
        bs: '8',
        latestVersion: '10',
      });
    });

    it('should format ss values correctly for values >= 1024', async () => {
      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // 4096 -> 4k
      expect(writtenData['llama-3p1-70b-ss4096-bs1-sd9'].ss).toBe('4k');

      // 2048 -> 2k
      expect(writtenData['qwen2-5-72b-ss2048-bs16'].ss).toBe('2k');
    });

    it('should keep ss values as-is for values < 1024', async () => {
      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // 512 -> "512"
      expect(writtenData['model-ss512-bs8'].ss).toBe('512');
    });

    it('should determine latest version correctly', async () => {
      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // Versions 1, 2, 3 -> latest is 3
      expect(writtenData['llama-3p1-70b-ss4096-bs1-sd9'].latestVersion).toBe('3');

      // Versions 5, 10 -> latest is 10
      expect(writtenData['model-ss512-bs8'].latestVersion).toBe('10');

      // Version 1 only -> latest is 1
      expect(writtenData['qwen2-5-72b-ss2048-bs16'].latestVersion).toBe('1');
    });

    it('should handle PEFs without versions', async () => {
      const kubectlOutputWithoutVersions = {
        items: [
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: {},
          },
        ],
      };

      (execSync as jest.Mock).mockReturnValue(JSON.stringify(kubectlOutputWithoutVersions));

      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      expect(writtenData['model-ss1024-bs1'].latestVersion).toBe('1');
    });

    it('should skip PEFs with invalid names', async () => {
      const kubectlOutputWithInvalidNames = {
        items: [
          {
            metadata: { name: 'invalid-pef-name' },
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      (execSync as jest.Mock).mockReturnValue(JSON.stringify(kubectlOutputWithInvalidNames));

      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // Should only have the valid PEF
      expect(Object.keys(writtenData).length).toBe(1);
      expect(writtenData['model-ss1024-bs1']).toBeDefined();
      expect(writtenData['invalid-pef-name']).toBeUndefined();
    });

    it('should return success with correct count', async () => {
      const result = await generatePefConfigs();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.count).toBe(3);
      }
    });

    it('should handle empty PEF list', async () => {
      (execSync as jest.Mock).mockReturnValue(JSON.stringify({ items: [] }));

      const result = await generatePefConfigs();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.count).toBe(0);
      }
    });

    it('should handle DYT PEFs by generating a cartesian product of selected SS x BS values', async () => {
      const listOutput = {
        items: [
          {
            metadata: { name: 'gpt-oss-fp8-ss131072-bs8-dyt-1' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      const individualPefOutput = {
        metadata: { name: 'gpt-oss-fp8-ss131072-bs8-dyt-1' },
        spec: {
          metadata: {
            dynamic_dims: {
              batch_size: { values: [2, 4, 6, 8] },
              decode_seq: { min: 8192, max: 131072, step: 4096 },
            },
          },
          versions: { '1': {} },
        },
      };

      (execSync as jest.Mock).mockImplementation((cmd: string) => {
        if (cmd === 'kubectl -n default get pef -o json') {
          return JSON.stringify(listOutput);
        }
        return JSON.stringify(individualPefOutput);
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.count).toBe(1);
      }

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // selected_ss = [128k, 64k, 32k] (halving from max, filtered >= 32k)
      // cartesian product with bs=[2,4,6,8] => 3*4=12 items
      expect(writtenData['gpt-oss-fp8-ss131072-bs8-dyt-1']).toEqual([
        { ss: '128k', bs: '2', latestVersion: '1' },
        { ss: '128k', bs: '4', latestVersion: '1' },
        { ss: '128k', bs: '6', latestVersion: '1' },
        { ss: '128k', bs: '8', latestVersion: '1' },
        { ss: '64k', bs: '2', latestVersion: '1' },
        { ss: '64k', bs: '4', latestVersion: '1' },
        { ss: '64k', bs: '6', latestVersion: '1' },
        { ss: '64k', bs: '8', latestVersion: '1' },
        { ss: '32k', bs: '2', latestVersion: '1' },
        { ss: '32k', bs: '4', latestVersion: '1' },
        { ss: '32k', bs: '6', latestVersion: '1' },
        { ss: '32k', bs: '8', latestVersion: '1' },
      ]);
    });

    it('should fall back to single SS (max) for DYT PEFs without min/step in decode_seq', async () => {
      const listOutput = {
        items: [
          {
            metadata: { name: 'gpt-oss-fp8-ss131072-bs8-dyt-1' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      const individualPefOutput = {
        metadata: { name: 'gpt-oss-fp8-ss131072-bs8-dyt-1' },
        spec: {
          metadata: {
            dynamic_dims: {
              batch_size: { values: [2, 4, 6, 8] },
              decode_seq: { max: 131072 },
            },
          },
          versions: { '1': {} },
        },
      };

      (execSync as jest.Mock).mockImplementation((cmd: string) => {
        if (cmd === 'kubectl -n default get pef -o json') {
          return JSON.stringify(listOutput);
        }
        return JSON.stringify(individualPefOutput);
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(true);

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      expect(writtenData['gpt-oss-fp8-ss131072-bs8-dyt-1']).toEqual([
        { ss: '128k', bs: '2', latestVersion: '1' },
        { ss: '128k', bs: '4', latestVersion: '1' },
        { ss: '128k', bs: '6', latestVersion: '1' },
        { ss: '128k', bs: '8', latestVersion: '1' },
      ]);
    });

    it('should skip DYT PEF when all SS values are filtered out (all below 32k)', async () => {
      const listOutput = {
        items: [
          {
            metadata: { name: 'small-model-dyt-1' },
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      // max=16384 (16k): halving gives [16k, 8k, 4k, ...], all < 32k — no valid SS
      const individualPefOutput = {
        metadata: { name: 'small-model-dyt-1' },
        spec: {
          metadata: {
            dynamic_dims: {
              batch_size: { values: [1, 2] },
              decode_seq: { min: 4096, max: 16384, step: 4096 },
            },
          },
          versions: { '1': {} },
        },
      };

      (execSync as jest.Mock).mockImplementation((cmd: string) => {
        if (cmd === 'kubectl -n default get pef -o json') {
          return JSON.stringify(listOutput);
        }
        return JSON.stringify(individualPefOutput);
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(true);

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      expect(writtenData['small-model-dyt-1']).toBeUndefined();
      expect(writtenData['model-ss1024-bs1']).toBeDefined();
    });

    it('should skip DYT PEFs missing dynamic_dims data', async () => {
      const listOutput = {
        items: [
          {
            metadata: { name: 'model-dyt-broken' },
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      const brokenDytOutput = {
        metadata: { name: 'model-dyt-broken' },
        spec: {
          versions: { '1': {} },
          // no metadata.dynamic_dims
        },
      };

      (execSync as jest.Mock).mockImplementation((cmd: string) => {
        if (cmd === 'kubectl -n default get pef -o json') {
          return JSON.stringify(listOutput);
        }
        return JSON.stringify(brokenDytOutput);
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(true);

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // DYT PEF without dynamic_dims should be skipped
      expect(writtenData['model-dyt-broken']).toBeUndefined();
      // Normal PEF should still be processed
      expect(writtenData['model-ss1024-bs1']).toBeDefined();
    });

    it('should handle kubectl command failure', async () => {
      (execSync as jest.Mock).mockImplementation(() => {
        throw new Error('kubectl command failed');
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    });

    it('should handle invalid JSON from kubectl', async () => {
      (execSync as jest.Mock).mockReturnValue('invalid json');

      const result = await generatePefConfigs();

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    });

    it('should handle file write errors', async () => {
      (writeFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('Write failed');
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    });

    it('should use correct namespace from config', async () => {
      const configWithCustomNamespace = {
        ...mockAppConfig,
        kubeconfigs: {
          dev: {
            file: 'kubeconfigs/dev.yaml',
            namespace: 'custom-namespace',
          },
        },
      };

      (readFileSync as jest.Mock).mockReturnValue(JSON.stringify(configWithCustomNamespace));

      await generatePefConfigs();

      expect(execSync).toHaveBeenCalledWith(
        'kubectl -n custom-namespace get pef -o json',
        expect.any(Object)
      );
    });

    it('should use default namespace when not specified', async () => {
      const configWithoutNamespace = {
        ...mockAppConfig,
        kubeconfigs: {
          dev: {
            file: 'kubeconfigs/dev.yaml',
          },
        },
      };

      (readFileSync as jest.Mock).mockReturnValue(JSON.stringify(configWithoutNamespace));

      await generatePefConfigs();

      expect(execSync).toHaveBeenCalledWith(
        'kubectl -n default get pef -o json',
        expect.any(Object)
      );
    });

    it('should handle PEF names with various formats', async () => {
      const kubectlOutputWithVariousFormats = {
        items: [
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'another-model-ss2048-bs16-extra-suffix' },
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'prefix-ss512-middle-bs8-suffix' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      (execSync as jest.Mock).mockReturnValue(JSON.stringify(kubectlOutputWithVariousFormats));

      const result = await generatePefConfigs();

      if (!result.success) {
        console.error('Test failed with error:', result.error);
      }
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.count).toBe(3);
      }

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      expect(writtenData['model-ss1024-bs1']).toEqual({
        ss: '1k',
        bs: '1',
        latestVersion: '1',
      });

      expect(writtenData['another-model-ss2048-bs16-extra-suffix']).toEqual({
        ss: '2k',
        bs: '16',
        latestVersion: '1',
      });

      expect(writtenData['prefix-ss512-middle-bs8-suffix']).toEqual({
        ss: '512',
        bs: '8',
        latestVersion: '1',
      });
    });

    it('should remove non-DYT PEFs for a model when a DYT PEF is present', async () => {
      const listOutput = {
        items: [
          {
            metadata: { name: 'gpt-oss-fp8-ss131072-bs8-dyt-1' },
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'gpt-oss-fp8-ss4096-bs1' },
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'unrelated-model-ss4096-bs1' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      const individualPefOutput = {
        metadata: { name: 'gpt-oss-fp8-ss131072-bs8-dyt-1' },
        spec: {
          metadata: {
            dynamic_dims: {
              batch_size: { values: [2, 4] },
              decode_seq: { min: 8192, max: 131072, step: 4096 },
            },
          },
          versions: { '1': {} },
        },
      };

      const pefMapping = {
        'some-model': ['gpt-oss-fp8-ss131072-bs8-dyt-1', 'gpt-oss-fp8-ss4096-bs1'],
      };

      (execSync as jest.Mock).mockImplementation((cmd: string) => {
        if (cmd === 'kubectl -n default get pef -o json') {
          return JSON.stringify(listOutput);
        }
        return JSON.stringify(individualPefOutput);
      });

      (readFileSync as jest.Mock).mockImplementation((filePath: string) => {
        if (String(filePath).includes('pef_mapping.json')) {
          return JSON.stringify(pefMapping);
        }
        return JSON.stringify({ ...mockAppConfig, betaFeatures: ['dyt'] });
      });

      const result = await generatePefConfigs();

      expect(result.success).toBe(true);

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // DYT PEF should be present
      expect(writtenData['gpt-oss-fp8-ss131072-bs8-dyt-1']).toBeDefined();
      // Non-DYT PEF for the same model should be removed
      expect(writtenData['gpt-oss-fp8-ss4096-bs1']).toBeUndefined();
      // Unrelated model PEF should still be present
      expect(writtenData['unrelated-model-ss4096-bs1']).toBeDefined();
    });

    it('should handle version numbers as strings', async () => {
      const kubectlOutputWithStringVersions = {
        items: [
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: {
              versions: {
                '1': {},
                '2': {},
                '15': {},
                '3': {},
              },
            },
          },
        ],
      };

      (execSync as jest.Mock).mockReturnValue(JSON.stringify(kubectlOutputWithStringVersions));

      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // Should parse string versions and find max
      expect(writtenData['model-ss1024-bs1'].latestVersion).toBe('15');
    });

  });
});

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
    (readFileSync as jest.Mock).mockReturnValue(JSON.stringify(mockAppConfig));
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

    it('should skip PEFs without metadata name', async () => {
      const kubectlOutputWithoutName = {
        items: [
          {
            metadata: {},
            spec: { versions: { '1': {} } },
          },
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: { versions: { '1': {} } },
          },
        ],
      };

      (execSync as jest.Mock).mockReturnValue(JSON.stringify(kubectlOutputWithoutName));

      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      expect(Object.keys(writtenData).length).toBe(1);
      expect(writtenData['model-ss1024-bs1']).toBeDefined();
    });

    it('should return success with correct count', async () => {
      const result = await generatePefConfigs();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.count).toBe(3);
      }
    });

    it('should write to correct output path', async () => {
      await generatePefConfigs();

      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/app[\/\\]data[\/\\]pef_configs\.json$/),
        expect.any(String),
        'utf-8'
      );
    });

    it('should write valid JSON with proper formatting', async () => {
      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenJson = writeCall[1];

      // Should be valid JSON
      expect(() => JSON.parse(writtenJson)).not.toThrow();

      // Should be formatted with 2-space indentation
      expect(writtenJson).toContain('\n  ');
    });

    it('should handle empty PEF list', async () => {
      (execSync as jest.Mock).mockReturnValue(JSON.stringify({ items: [] }));

      const result = await generatePefConfigs();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.count).toBe(0);
      }
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

    it('should handle mixed valid and invalid version numbers', async () => {
      const kubectlOutputWithMixedVersions = {
        items: [
          {
            metadata: { name: 'model-ss1024-bs1' },
            spec: {
              versions: {
                '1': {},
                invalid: {},
                '5': {},
                '': {},
              },
            },
          },
        ],
      };

      (execSync as jest.Mock).mockReturnValue(JSON.stringify(kubectlOutputWithMixedVersions));

      await generatePefConfigs();

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1]);

      // Should ignore invalid versions and use highest valid one
      expect(writtenData['model-ss1024-bs1'].latestVersion).toBe('5');
    });
  });
});

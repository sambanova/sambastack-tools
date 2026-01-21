import { generateBundleYaml, generateCheckpointName } from '../bundle-yaml-generator';
import { mockCheckpointMapping, mockPefConfigs } from './mock-data';
import type { ConfigSelection } from '../../types/bundle';

describe('bundle-yaml-generator', () => {
  describe('generateCheckpointName', () => {
    it('should convert model name to uppercase checkpoint name', () => {
      const result = generateCheckpointName('Meta-Llama-3.1-8B-Instruct');
      expect(result).toBe('META_LLAMA_3_1_8B_INSTRUCT_CKPT');
    });

    it('should replace hyphens with underscores', () => {
      const result = generateCheckpointName('my-model-name');
      expect(result).toBe('MY_MODEL_NAME_CKPT');
    });

    it('should replace periods with underscores', () => {
      const result = generateCheckpointName('model.v1.0');
      expect(result).toBe('MODEL_V1_0_CKPT');
    });

    it('should remove special characters', () => {
      const result = generateCheckpointName('model@name#123');
      expect(result).toBe('MODEL_NAME_123_CKPT');
    });

    it('should collapse multiple underscores', () => {
      const result = generateCheckpointName('model---name');
      expect(result).toBe('MODEL_NAME_CKPT');
    });

    it('should remove leading and trailing underscores', () => {
      const result = generateCheckpointName('-model-name-');
      expect(result).toBe('MODEL_NAME_CKPT');
    });
  });

  describe('generateBundleYaml', () => {
    const selectedConfigs: ConfigSelection[] = [
      {
        modelName: 'Meta-Llama-3.1-8B-Instruct',
        ss: '1024',
        bs: '1',
        pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
      },
      {
        modelName: 'Meta-Llama-3.1-8B-Instruct',
        ss: '2048',
        bs: '1',
        pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss2048',
      },
    ];

    it('should generate valid YAML structure', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('apiVersion: sambanova.ai/v1alpha1');
      expect(yaml).toContain('kind: BundleTemplate');
      expect(yaml).toContain('kind: Bundle');
    });

    it('should include bundle name in metadata', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'my-bundle'
      );

      expect(yaml).toContain('name: bt-my-bundle');
      expect(yaml).toContain('name: b-my-bundle');
    });

    it('should include model configurations', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('Meta-Llama-3.1-8B-Instruct:');
      expect(yaml).toContain('batch_size: 1');
      expect(yaml).toContain('num_tokens_at_a_time: 20');
    });

    it('should generate unique ckpt_sharing_uuid for each SS', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '16',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs16_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '2048',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss2048',
        },
      ];

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('ckpt_sharing_uuid: id1');
      expect(yaml).toContain('ckpt_sharing_uuid: id2');
    });

    it('should include PEF names with versions', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('pef: COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024:1');
      expect(yaml).toContain('pef: COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss2048:1');
    });

    it('should include checkpoint source path', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle',
        'gs://my-bucket/'
      );

      expect(yaml).toContain('source: gs://my-bucket//checkpoints/llama-3.1-8b');
    });

    it('should use empty source when checkpointsDir is not provided', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('source: /checkpoints/llama-3.1-8b');
    });

    it('should set toolSupport to true for all checkpoints', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('toolSupport: true');
    });

    it('should include owner and secretNames', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('owner: no-reply@sambanova.ai');
      expect(yaml).toContain('secretNames:');
      expect(yaml).toContain('- sambanova-artifact-reader');
    });

    it('should handle multiple models', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Qwen2.5-72B-Instruct',
          ss: '4096',
          bs: '1',
          pefName: 'COE_Qwen2-5-72B-Instruct_131k_bs1_ss4096',
        },
      ];

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('Meta-Llama-3.1-8B-Instruct:');
      expect(yaml).toContain('Qwen2.5-72B-Instruct:');
      expect(yaml).toContain('META_LLAMA_3_1_8B_INSTRUCT_CKPT:');
      expect(yaml).toContain('QWEN2_5_72B_INSTRUCT_CKPT:');
    });

    it('should handle speculative decoding with draft models', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
        },
      ];

      const draftModels = {
        'Meta-Llama-3.1-70B-Instruct': 'Meta-Llama-3.1-8B-Instruct',
      };

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle',
        '',
        draftModels
      );

      expect(yaml).toContain('spec_decoding:');
      expect(yaml).toContain('draft_expert: 1024');
      expect(yaml).toContain('draft_model: Meta-Llama-3.1-8B-Instruct');
    });

    it('should set num_tokens_at_a_time to 1 for target models with spec decoding', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
        },
      ];

      const draftModels = {
        'Meta-Llama-3.1-70B-Instruct': 'Meta-Llama-3.1-8B-Instruct',
      };

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle',
        '',
        draftModels
      );

      // Target model should have num_tokens_at_a_time: 1
      const targetSection = yaml.split('Meta-Llama-3.1-70B-Instruct:')[1].split('Meta-Llama-3.1-8B-Instruct:')[0];
      expect(targetSection).toContain('num_tokens_at_a_time: 1');

      // Draft model should have num_tokens_at_a_time: 20
      const draftSection = yaml.split('Meta-Llama-3.1-8B-Instruct:')[1];
      expect(draftSection).toContain('num_tokens_at_a_time: 20');
    });

    it('should set num_tokens_at_a_time to 20 for models without spec decoding', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).toContain('num_tokens_at_a_time: 20');
    });

    it('should not add spec_decoding when draft model is "skip"', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
        },
      ];

      const draftModels = {
        'Meta-Llama-3.1-70B-Instruct': 'skip',
      };

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle',
        '',
        draftModels
      );

      expect(yaml).not.toContain('spec_decoding:');
    });

    it('should only add spec_decoding when matching draft config exists', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '2048',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss2048',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
        },
      ];

      const draftModels = {
        'Meta-Llama-3.1-70B-Instruct': 'Meta-Llama-3.1-8B-Instruct',
      };

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle',
        '',
        draftModels
      );

      // Only the 1024 config should have spec_decoding (it has a matching draft config)
      // Check that the YAML contains spec_decoding for the 1024 config
      expect(yaml).toContain('spec_decoding:');

      // Count occurrences of spec_decoding (should only be 1)
      const specDecodingMatches = yaml.match(/spec_decoding:/g);
      expect(specDecodingMatches).toHaveLength(1);
    });

    it('should group configs by sequence size (SS)', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '16',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs16_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '2048',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss2048',
        },
      ];

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      // Should have two SS groups
      expect(yaml).toContain('1024:');
      expect(yaml).toContain('2048:');

      // Both batch sizes should appear in the YAML (they'll be under the same 1024 SS group)
      expect(yaml).toContain('batch_size: 1');
      expect(yaml).toContain('batch_size: 16');

      // Both should have the same ckpt_sharing_uuid since they're in the same SS group
      expect(yaml).toContain('ckpt_sharing_uuid: id1');
    });
  });
});

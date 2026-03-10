import { generateBundleYaml, generateCheckpointName, generateVisionEmbeddingCheckpointName } from '../bundle-yaml-generator';
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

  describe('generateVisionEmbeddingCheckpointName', () => {
    it('should generate vision embedding checkpoint name and remove -Instruct suffix', () => {
      const result = generateVisionEmbeddingCheckpointName('Llama-4-Maverick-17B-128E-Instruct');
      expect(result).toBe('LLAMA_4_MAVERICK_17B_128E_VISION_EMBD_CKPT');
    });

    it('should remove _INSTRUCT suffix for models ending with _instruct', () => {
      const result = generateVisionEmbeddingCheckpointName('Model_Name_Instruct');
      expect(result).toBe('MODEL_NAME_VISION_EMBD_CKPT');
    });

    it('should handle model names without instruct suffix', () => {
      const result = generateVisionEmbeddingCheckpointName('Custom-Model');
      expect(result).toBe('CUSTOM_MODEL_VISION_EMBD_CKPT');
    });

    it('should remove -instruct suffix after transformation', () => {
      const result = generateVisionEmbeddingCheckpointName('my-model.v1-instruct');
      expect(result).toBe('MY_MODEL_V1_VISION_EMBD_CKPT');
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
      expect(yaml).toContain('pef: COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024:1');
    });

    it('should group configs by SS', () => {
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

      expect(yaml).toContain('1024:');
      expect(yaml).toContain('2048:');
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

    it('should handle speculative decoding with draft models using default_config_values', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '16',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs16_ss1024',
        },
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

      // Should use default_config_values when multiple configs all have matching draft configs
      expect(yaml).toContain('spec_decoding:');
      expect(yaml).toContain('default_config_values:');
      expect(yaml).toContain('draft_model: Meta-Llama-3.1-8B-Instruct');
    });

    it('should handle speculative decoding with per-config spec_decoding when not all configs have draft', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '1024',
          bs: '16',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs16_ss1024',
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

      // Should have spec_decoding but NOT default_config_values (since not all configs have draft)
      expect(yaml).toContain('spec_decoding:');
      expect(yaml).not.toContain('default_config_values:');

      // Should have inline spec_decoding for the config with draft
      const targetSection = yaml.split('Meta-Llama-3.1-70B-Instruct:')[1].split('Meta-Llama-3.1-8B-Instruct:')[0];
      expect(targetSection).toContain('draft_model: Meta-Llama-3.1-8B-Instruct');
    });

    it('should not include spec_decoding for models without draft models', () => {
      const yaml = generateBundleYaml(
        selectedConfigs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      expect(yaml).not.toContain('spec_decoding:');
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
          ss: '4k',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
        },
        {
          modelName: 'Meta-Llama-3.1-70B-Instruct',
          ss: '8k',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss2048',
        },
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '4k',
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

      // Only the 4k SS should have spec_decoding (it has a matching draft config)
      expect(yaml).toContain('spec_decoding:');

      // Get the target model section
      const targetModelSection = yaml.split('Meta-Llama-3.1-70B-Instruct:')[1].split('Meta-Llama-3.1-8B-Instruct:')[0];

      // The 4k SS has only 1 config, so should use per-config spec_decoding (not default_config_values)
      expect(targetModelSection).toContain('4k:');
      expect(targetModelSection).toContain('spec_decoding:');
      expect(targetModelSection).toContain('draft_model: Meta-Llama-3.1-8B-Instruct');

      // The 8k SS should NOT have spec_decoding (no matching draft config)
      expect(targetModelSection).toContain('8k:');
      const section8k = targetModelSection.split('8k:')[1];
      expect(section8k).not.toContain('spec_decoding:');
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

      // Both PEFs should appear in the YAML (they'll be under the same 1024 SS group)
      expect(yaml).toContain('COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024');
      expect(yaml).toContain('COE_Meta-Llama-3-1-8B-Instruct_32k_bs16_ss1024');
    });

    it('should include vision embedding checkpoint when present in checkpoint mapping', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Llama-4-Maverick-17B-128E-Instruct',
          ss: '8k',
          bs: '1',
          pefName: 'llama-4-maverick-ss8192-bs1',
        },
      ];

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle',
        'gs://my-bucket/'
      );

      // Should include the main checkpoint
      expect(yaml).toContain('LLAMA_4_MAVERICK_17B_128E_INSTRUCT_CKPT:');
      expect(yaml).toContain('source: gs://my-bucket//checkpoints/llama-4-maverick');

      // Should include the vision embedding checkpoint (without _INSTRUCT suffix)
      expect(yaml).toContain('LLAMA_4_MAVERICK_17B_128E_VISION_EMBD_CKPT:');
      expect(yaml).toContain('source: gs://my-bucket//checkpoints/llama-4-maverick-vision');

      // Should include vision_embedding_checkpoint reference in the model
      expect(yaml).toContain('Llama-4-Maverick-17B-128E-Instruct:');
      expect(yaml).toContain('checkpoint: LLAMA_4_MAVERICK_17B_128E_INSTRUCT_CKPT');
      expect(yaml).toContain('vision_embedding_checkpoint: LLAMA_4_MAVERICK_17B_128E_VISION_EMBD_CKPT');
    });

    it('should not include vision embedding checkpoint when not present in checkpoint mapping', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'Meta-Llama-3.1-8B-Instruct',
          ss: '1024',
          bs: '1',
          pefName: 'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
        },
      ];

      const yaml = generateBundleYaml(
        configs,
        mockCheckpointMapping,
        mockPefConfigs,
        'test-bundle'
      );

      // Should include the main checkpoint
      expect(yaml).toContain('META_LLAMA_3_1_8B_INSTRUCT_CKPT:');

      // Should NOT include vision embedding checkpoint
      expect(yaml).not.toContain('VISION_EMBD_CKPT');
      expect(yaml).not.toContain('vision_embedding_checkpoint:');
    });

    it('should rename smallest SS expert key to "default" for embedding models', () => {
      const configs: ConfigSelection[] = [
        {
          modelName: 'E5-Mistral-7B-Instruct',
          ss: '4k',
          bs: '1',
          pefName: 'E5-Mistral-7B-Instruct_4k_bs1',
        },
        {
          modelName: 'E5-Mistral-7B-Instruct',
          ss: '8k',
          bs: '1',
          pefName: 'E5-Mistral-7B-Instruct_8k_bs1',
        },
      ];

      const yaml = generateBundleYaml(configs, mockCheckpointMapping, mockPefConfigs, 'test-bundle');

      // Smallest SS (4k) should be renamed to 'default'
      expect(yaml).toContain('default:');
      expect(yaml).not.toContain('4k:');
      // Larger SS key stays as-is
      expect(yaml).toContain('8k:');
    });

    it('should NOT rename smallest SS expert key to "default" for non-embedding models', () => {
      const configs: ConfigSelection[] = [
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

      const yaml = generateBundleYaml(configs, mockCheckpointMapping, mockPefConfigs, 'test-bundle');

      // SS keys should remain unchanged
      expect(yaml).toContain('1024:');
      expect(yaml).toContain('2048:');
      expect(yaml).not.toContain('default:');
    });
  });
});

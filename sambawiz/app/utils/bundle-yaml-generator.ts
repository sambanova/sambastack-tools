import type { ConfigSelection, CheckpointMapping, PefConfigs } from '../types/bundle';

interface ModelExpertConfig {
  pef: string;
  spec_decoding?: {
    draft_model: string;
  };
  _hasSpecDecoding?: boolean; // Internal flag for tracking spec_decoding configs
}

interface ModelExperts {
  [ss: string]: {
    configs: ModelExpertConfig[];
    default_config_values?: {
      spec_decoding?: {
        draft_model: string;
      };
    };
  };
}

interface BundleTemplateModels {
  [modelName: string]: {
    experts: ModelExperts;
  };
}

/**
 * Generate checkpoint name from model name
 */
export function generateCheckpointName(modelName: string): string {
  return modelName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') + '_CKPT';
}

/**
 * Generate vision embedding checkpoint name from model name
 */
export function generateVisionEmbeddingCheckpointName(modelName: string): string {
  const checkpointBaseName = modelName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  // Check if the transformed checkpoint base name ends with "_INSTRUCT"
  if (checkpointBaseName.endsWith('_INSTRUCT')) {
    // Remove "_INSTRUCT" suffix from the base name
    return checkpointBaseName.replace(/_INSTRUCT$/, '') + '_VISION_EMBD_CKPT';
  }

  return checkpointBaseName + '_VISION_EMBD_CKPT';
}

/**
 * Generate complete bundle YAML from selected configurations
 */
export function generateBundleYaml(
  selectedConfigs: ConfigSelection[],
  checkpointMapping: CheckpointMapping,
  pefConfigs: PefConfigs,
  bundleName: string,
  checkpointsDir: string = '',
  draftModels: { [modelName: string]: string } = {}
): string {
  // Group configs by model
  const modelConfigs: { [modelName: string]: ConfigSelection[] } = {};
  selectedConfigs.forEach(config => {
    if (!modelConfigs[config.modelName]) {
      modelConfigs[config.modelName] = [];
    }
    modelConfigs[config.modelName].push(config);
  });

  // Build BundleTemplate spec.models
  const templateModels: BundleTemplateModels = {};

  Object.entries(modelConfigs).forEach(([modelName, configs]) => {
    const experts: ModelExperts = {};

    // Check if this model has a draft model assigned
    const draftModel = draftModels[modelName];
    const hasDraftModel = draftModel && draftModel !== 'skip';

    // Group by SS
    configs.forEach(config => {
      if (!experts[config.ss]) {
        experts[config.ss] = { configs: [] };
      }

      const version = pefConfigs[config.pefName]?.latestVersion || '1';

      // Check if this config will have spec_decoding (i.e., is a target model with matching draft config)
      let hasMatchingDraftConfig = false;
      if (hasDraftModel) {
        const draftModelHasMatchingConfig = selectedConfigs.some(
          (sc) => sc.modelName === draftModel && sc.ss === config.ss && sc.bs === config.bs
        );
        hasMatchingDraftConfig = draftModelHasMatchingConfig;
      }

      const expertConfig: ModelExpertConfig = {
        pef: `${config.pefName}:${version}`
      };

      experts[config.ss].configs.push(expertConfig);

      // Track if this specific config needs spec_decoding
      if (hasMatchingDraftConfig) {
        expertConfig._hasSpecDecoding = true;
      }
    });

    // For each expert (SS level), determine if we should use default_config_values or per-config spec_decoding
    // Use default_config_values only when:
    // 1. There are multiple configs for this SS/expert
    // 2. ALL configs have matching draft configs
    if (hasDraftModel) {
      Object.entries(experts).forEach(([, expert]) => {
        // Check if ALL configs in this expert have matching draft configs
        const allConfigsHaveDraft = expert.configs.every((config) => config._hasSpecDecoding);
        const hasMultipleConfigs = expert.configs.length > 1;

        if (allConfigsHaveDraft && hasMultipleConfigs) {
          // Use default_config_values for this expert (saves YAML lines when multiple configs exist)
          expert.default_config_values = {
            spec_decoding: {
              draft_model: draftModel
            }
          };
          // Clean up temporary flags
          expert.configs.forEach((config: ModelExpertConfig) => delete config._hasSpecDecoding);
        } else {
          // Use per-config spec_decoding
          expert.configs.forEach((config: ModelExpertConfig) => {
            if (config._hasSpecDecoding) {
              config.spec_decoding = {
                draft_model: draftModel
              };
              delete config._hasSpecDecoding;
            }
          });
        }
      });
    }

    templateModels[modelName] = { experts };
  });

  // Build Bundle spec.checkpoints
  const checkpoints: { [key: string]: { source: string; toolSupport: boolean } } = {};
  Object.keys(modelConfigs).forEach(modelName => {
    const checkpointName = generateCheckpointName(modelName);
    const checkpointData = checkpointMapping[modelName];
    const checkpointPath = checkpointData?.path || '';
    const fullCheckpointPath = checkpointsDir ? `${checkpointsDir}${checkpointPath}` : checkpointPath;
    checkpoints[checkpointName] = {
      source: fullCheckpointPath,
      toolSupport: true
    };

    // Add vision embedding checkpoint if present
    if (checkpointData?.vision_embedding_checkpoint) {
      const visionEmbeddingCheckpointName = generateVisionEmbeddingCheckpointName(modelName);
      const visionEmbeddingPath = checkpointData.vision_embedding_checkpoint;
      const fullVisionEmbeddingPath = checkpointsDir ? `${checkpointsDir}${visionEmbeddingPath}` : visionEmbeddingPath;
      checkpoints[visionEmbeddingCheckpointName] = {
        source: fullVisionEmbeddingPath,
        toolSupport: true
      };
    }
  });

  // Build Bundle spec.models
  const bundleModels: { [key: string]: { checkpoint: string; template: string; vision_embedding_checkpoint?: string } } = {};
  Object.keys(modelConfigs).forEach(modelName => {
    const checkpointName = generateCheckpointName(modelName);
    const checkpointData = checkpointMapping[modelName];
    const model: { checkpoint: string; template: string; vision_embedding_checkpoint?: string } = {
      checkpoint: checkpointName,
      template: modelName
    };

    // Add vision embedding checkpoint reference if present
    if (checkpointData?.vision_embedding_checkpoint) {
      model.vision_embedding_checkpoint = generateVisionEmbeddingCheckpointName(modelName);
    }

    bundleModels[modelName] = model;
  });

  // Generate YAML strings
  const bundleTemplateName = `bt-${bundleName}`;
  const bundleManifestName = `b-${bundleName}`;

  const bundleTemplateYaml = `apiVersion: sambanova.ai/v1alpha1
kind: BundleTemplate
metadata:
  name: ${bundleTemplateName}
spec:
  models:
${Object.entries(templateModels).map(([modelName, model]) => {
  return `    ${modelName}:
      experts:
${Object.entries(model.experts).map(([ss, expert]) => {
  let expertStr = `        ${ss}:
          configs:
${expert.configs.map(config => {
  let configStr = `          - pef: ${config.pef}`;
  if (config.spec_decoding) {
    configStr += `
            spec_decoding:
              draft_model: ${config.spec_decoding.draft_model}`;
  }
  return configStr;
}).join('\n')}`;

  // Add default_config_values if present
  if (expert.default_config_values?.spec_decoding) {
    expertStr += `
          default_config_values:
            spec_decoding:
              draft_model: ${expert.default_config_values.spec_decoding.draft_model}`;
  }

  return expertStr;
}).join('\n')}`;
}).join('\n')}
  owner: no-reply@sambanova.ai
  secretNames:
  - sambanova-artifact-reader
  usePefCRs: true`;

  const bundleYaml = `apiVersion: sambanova.ai/v1alpha1
kind: Bundle
metadata:
  name: ${bundleManifestName}
spec:
  checkpoints:
${Object.entries(checkpoints).map(([name, checkpoint]) => {
  return `    ${name}:
      source: ${checkpoint.source}
      toolSupport: ${checkpoint.toolSupport}`;
}).join('\n')}
  models:
${Object.entries(bundleModels).map(([modelName, model]) => {
  let modelStr = `    ${modelName}:
      checkpoint: ${model.checkpoint}
      template: ${model.template}`;
  if (model.vision_embedding_checkpoint) {
    modelStr += `
      vision_embedding_checkpoint: ${model.vision_embedding_checkpoint}`;
  }
  return modelStr;
}).join('\n')}
  secretNames:
  - sambanova-artifact-reader
  template: ${bundleTemplateName}`;

  return `${bundleTemplateYaml}\n---\n${bundleYaml}\n`;
}

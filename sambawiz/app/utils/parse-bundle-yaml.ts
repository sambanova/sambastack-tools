import yaml from 'js-yaml';
import pefConfigsData from '@/app/data/pef_configs.json';
import type { PefConfigs, ConfigSelection } from '@/app/types/bundle';

const pefConfigs: PefConfigs = pefConfigsData;

interface YamlBundleTemplate {
  metadata: {
    name: string;
  };
  spec: {
    models: {
      [modelName: string]: {
        default_expert_values?: {
          spec_decoding?: {
            draft_model: string;
          };
        };
        experts: {
          [contextLength: string]: {
            configs: Array<{
              pef: string;
              dynamic_dims?: {
                batch_size?: {
                  values?: number[];
                };
              };
              spec_decoding?: {
                draft_model: string;
              };
            }>;
            default_config_values?: {
              spec_decoding?: {
                draft_model: string;
              };
            };
          };
        };
      };
    };
  };
}

export interface ParsedBundleState {
  bundleName: string;
  selectedModels: string[];
  selectedConfigs: ConfigSelection[];
  draftModels: { [modelName: string]: string };
}

export type ParseError = { error: string };

export interface ParseOptions {
  /** When true, silently skip configs whose PEF is not in pef_configs.json instead of returning an error */
  skipUnknownPefs?: boolean;
}

export function parseBundleYamlContent(yamlContent: string, options?: ParseOptions): ParsedBundleState | ParseError {
  const documents = yaml.loadAll(yamlContent) as Array<Record<string, unknown>>;

  const bundleTemplate = documents.find(
    (doc) => doc?.kind === 'BundleTemplate'
  ) as YamlBundleTemplate | undefined;

  if (!bundleTemplate) {
    return { error: 'Unsupported YAML structure: expecting a document with "kind: BundleTemplate"' };
  }

  if (!bundleTemplate.spec?.models) {
    return { error: 'Unsupported YAML structure: expecting "spec.models" in BundleTemplate' };
  }

  const bundleTemplateName = bundleTemplate.metadata.name;
  const bundleName = bundleTemplateName.startsWith('bt-')
    ? bundleTemplateName.substring(3)
    : bundleTemplateName;

  const selectedModels: string[] = [];
  const selectedConfigs: ConfigSelection[] = [];
  const draftModels: { [modelName: string]: string } = {};

  for (const [modelName, modelData] of Object.entries(bundleTemplate.spec.models)) {
    selectedModels.push(modelName);

    if (!modelData.experts) {
      return { error: `Unsupported YAML structure: expecting "experts" for model "${modelName}"` };
    }

    const draftModelsForThisModel: string[] = [];
    // Model-level spec_decoding default (e.g. default_expert_values.spec_decoding.draft_model)
    const modelDefaultDraftModel = modelData.default_expert_values?.spec_decoding?.draft_model;

    for (const [contextLength, expertData] of Object.entries(modelData.experts)) {
      if (!expertData.configs || !Array.isArray(expertData.configs)) {
        return {
          error: `Unsupported YAML structure: expecting "configs" array for model "${modelName}" expert "${contextLength}"`
        };
      }

      // Per-expert default takes priority over model-level default
      const defaultDraftModel =
        expertData.default_config_values?.spec_decoding?.draft_model ?? modelDefaultDraftModel;

      for (const config of expertData.configs) {
        const pefMatch = config.pef.match(/^(.+):(\d+)$/);
        if (!pefMatch) {
          return { error: `Invalid PEF format: "${config.pef}" (expecting "pef-name:version")` };
        }

        const pefName = pefMatch[1];

        const dytBatchSizes = config.dynamic_dims?.batch_size?.values;
        if (Array.isArray(dytBatchSizes) && dytBatchSizes.length > 0) {
          // 'default' was the renamed minimum-SS expert in old-format YAMLs.
          // Recover the actual SS so non-embedding models get their real expert key.
          let effectiveSs = contextLength;
          if (contextLength === 'default') {
            const pefEntry = pefConfigs[pefName];
            if (Array.isArray(pefEntry) && pefEntry.length > 0) {
              const ssToNum = (ss: string) => ss.endsWith('k') ? parseFloat(ss) * 1024 : parseFloat(ss);
              const minEntry = pefEntry.reduce((a, b) => ssToNum(a.ss) < ssToNum(b.ss) ? a : b);
              effectiveSs = minEntry.ss;
            }
          }
          for (const bs of dytBatchSizes) {
            selectedConfigs.push({ modelName, ss: effectiveSs, bs: bs.toString(), pefName });
          }
        } else {
          const pefConfig = pefConfigs[pefName];
          if (!pefConfig) {
            if (options?.skipUnknownPefs) continue;
            return { error: `PEF "${pefName}" not found in pef_configs.json` };
          }
          const pefEntry = Array.isArray(pefConfig) ? pefConfig[0] : pefConfig;
          if (!pefEntry) {
            return { error: `PEF "${pefName}" has no entries in pef_configs.json` };
          }
          selectedConfigs.push({ modelName, ss: pefEntry.ss, bs: pefEntry.bs, pefName });
        }

        const configDraftModel = config.spec_decoding?.draft_model || defaultDraftModel;
        if (configDraftModel) {
          draftModelsForThisModel.push(configDraftModel);
        }
      }
    }

    if (draftModelsForThisModel.length > 0) {
      const counts: { [key: string]: number } = {};
      draftModelsForThisModel.forEach(dm => {
        counts[dm] = (counts[dm] || 0) + 1;
      });

      let maxCount = 0;
      let mostCommonDraftModel = draftModelsForThisModel[0];
      for (const [dm, count] of Object.entries(counts)) {
        if (count > maxCount) {
          maxCount = count;
          mostCommonDraftModel = dm;
        }
      }

      draftModels[modelName] = mostCommonDraftModel;
    }
  }

  return {
    bundleName,
    selectedModels: [...new Set(selectedModels)],
    selectedConfigs,
    draftModels,
  };
}

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
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

interface ParsedBundleState {
  bundleName: string;
  selectedModels: string[];
  selectedConfigs: ConfigSelection[];
  draftModels: { [modelName: string]: string };
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const fileName = searchParams.get('fileName');

    if (!fileName) {
      return NextResponse.json({
        success: false,
        error: 'fileName parameter is required'
      }, { status: 400 });
    }

    const filePath = path.join(process.cwd(), 'saved_artifacts', fileName);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({
        success: false,
        error: `File not found: ${fileName}`
      }, { status: 404 });
    }

    // Read and parse YAML
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const documents = yaml.loadAll(fileContent) as Array<Record<string, unknown>>;

    // Find BundleTemplate (should be first document)
    const bundleTemplate = documents.find(
      (doc) => doc?.kind === 'BundleTemplate'
    ) as YamlBundleTemplate | undefined;

    if (!bundleTemplate) {
      return NextResponse.json({
        success: false,
        error: 'Unsupported YAML structure: expecting a document with "kind: BundleTemplate"'
      }, { status: 400 });
    }

    // Validate structure
    if (!bundleTemplate.spec?.models) {
      return NextResponse.json({
        success: false,
        error: 'Unsupported YAML structure: expecting "spec.models" in BundleTemplate'
      }, { status: 400 });
    }

    // Extract bundle name (strip 'bt-' prefix if present, otherwise set to empty)
    const bundleTemplateName = bundleTemplate.metadata.name;
    const bundleName = bundleTemplateName.startsWith('bt-')
      ? bundleTemplateName.substring(3)
      : '';

    const selectedModels: string[] = [];
    const selectedConfigs: ConfigSelection[] = [];
    const draftModels: { [modelName: string]: string } = {};

    // Parse each model
    for (const [modelName, modelData] of Object.entries(bundleTemplate.spec.models)) {
      selectedModels.push(modelName);

      if (!modelData.experts) {
        return NextResponse.json({
          success: false,
          error: `Unsupported YAML structure: expecting "experts" for model "${modelName}"`
        }, { status: 400 });
      }

      // Track all draft models used for this target model
      const draftModelsForThisModel: string[] = [];

      // Parse each expert (context length)
      for (const [contextLength, expertData] of Object.entries(modelData.experts)) {
        if (!expertData.configs || !Array.isArray(expertData.configs)) {
          return NextResponse.json({
            success: false,
            error: `Unsupported YAML structure: expecting "configs" array for model "${modelName}" expert "${contextLength}"`
          }, { status: 400 });
        }

        // Get default draft model for this expert
        const defaultDraftModel = expertData.default_config_values?.spec_decoding?.draft_model;

        // Parse each config
        for (const config of expertData.configs) {
          // Parse PEF string (format: "pef-name:version")
          const pefMatch = config.pef.match(/^(.+):(\d+)$/);
          if (!pefMatch) {
            return NextResponse.json({
              success: false,
              error: `Invalid PEF format: "${config.pef}" (expecting "pef-name:version")`
            }, { status: 400 });
          }

          const pefName = pefMatch[1];

          // Check if this is a DYT config (has dynamic_dims with batch size values)
          const dytBatchSizes = config.dynamic_dims?.batch_size?.values;
          if (Array.isArray(dytBatchSizes) && dytBatchSizes.length > 0) {
            // DYT: create one ConfigSelection per batch size; ss comes from expert key
            for (const bs of dytBatchSizes) {
              selectedConfigs.push({ modelName, ss: contextLength, bs: bs.toString(), pefName });
            }
          } else {
            // Non-DYT: look up ss and bs from pef_configs.json
            const pefConfig = pefConfigs[pefName];
            if (!pefConfig) {
              return NextResponse.json({
                success: false,
                error: `PEF "${pefName}" not found in pef_configs.json`
              }, { status: 400 });
            }
            const pefEntry = Array.isArray(pefConfig) ? pefConfig[0] : pefConfig;
            if (!pefEntry) {
              return NextResponse.json({
                success: false,
                error: `PEF "${pefName}" has no entries in pef_configs.json`
              }, { status: 400 });
            }
            selectedConfigs.push({ modelName, ss: pefEntry.ss, bs: pefEntry.bs, pefName });
          }

          // Determine draft model for this config: per-config overrides default
          const configDraftModel = config.spec_decoding?.draft_model || defaultDraftModel;
          if (configDraftModel) {
            draftModelsForThisModel.push(configDraftModel);
          }
        }
      }

      // Set the draft model for this target model (use the most common one)
      if (draftModelsForThisModel.length > 0) {
        // Count occurrences of each draft model
        const counts: { [key: string]: number } = {};
        draftModelsForThisModel.forEach(dm => {
          counts[dm] = (counts[dm] || 0) + 1;
        });

        // Find the most common draft model
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

    const result: ParsedBundleState = {
      bundleName,
      selectedModels: [...new Set(selectedModels)], // Remove duplicates
      selectedConfigs,
      draftModels
    };

    return NextResponse.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('Error loading bundle:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load bundle'
    }, { status: 500 });
  }
}

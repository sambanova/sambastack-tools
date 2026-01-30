import type { PefConfigs, PefMapping, CheckpointMapping } from '../types/bundle';

/**
 * Determines which models are available for bundle creation.
 *
 * A model is considered available if it satisfies BOTH conditions:
 *
 * 1. **Static condition**: Model exists in both checkpoint_mapping.json AND pef_mapping.json
 *    - checkpoint_mapping.json must have the model with a non-empty path
 *    - pef_mapping.json must have the model with a non-empty array of PEF names
 *
 * 2. **Dynamic condition**: At least one PEF config is actually available
 *    - At least one PEF name from pef_mapping.json must exist as a key in pef_configs.json
 *    - This changes dynamically based on the environment and available PEF compilations
 *
 * @param checkpointMapping - Mapping of models to checkpoint paths (static)
 * @param pefMapping - Mapping of models to PEF config names (static)
 * @param pefConfigs - Available PEF configurations with SS/BS settings (dynamic)
 * @returns Sorted array of available model names
 *
 * @example
 * // If pef_mapping has ["model-ss4k-bs1", "model-ss8k-bs1"] for "MyModel"
 * // but pef_configs only has "model-ss4k-bs1", the model is still available
 * // because at least one PEF config exists.
 */
export function getAvailableModels(
  checkpointMapping: CheckpointMapping,
  pefMapping: PefMapping,
  pefConfigs: PefConfigs
): string[] {
  // Get models that satisfy static condition
  const checkpointKeys = Object.keys(checkpointMapping).filter(
    (key) => checkpointMapping[key]?.path !== ''
  );
  const pefMappingKeys = Object.keys(pefMapping).filter(
    (key) => pefMapping[key].length > 0
  );
  const staticCandidates = checkpointKeys.filter((key) => pefMappingKeys.includes(key));

  // Filter by dynamic condition: at least one PEF config must exist in pefConfigs
  const availableModels = staticCandidates.filter((modelName) => {
    const modelPefs = pefMapping[modelName] || [];
    return modelPefs.some((pefName) => pefName in pefConfigs);
  });

  return availableModels.sort();
}

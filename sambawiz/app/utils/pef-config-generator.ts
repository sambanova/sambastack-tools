import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  uiDomain?: string;
  apiDomain?: string;
  apiKey?: string;
}

interface AppConfig {
  checkpointsDir: string;
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

interface PefConfig {
  ss: string;
  bs: string;
  latestVersion: string;
}

interface PefConfigs {
  [key: string]: PefConfig | PefConfig[];
}

interface KubectlPefItem {
  metadata?: {
    name?: string;
  };
  spec?: {
    metadata?: {
      task_name?: string;
      dynamic_dims?: {
        batch_size?: {
          values?: number[];
        };
        decode_seq?: {
          max?: number;
          min?: number;
          step?: number;
        };
      };
    };
    versions?: Record<string, unknown>;
  };
}

interface KubectlPefResponse {
  items?: KubectlPefItem[];
}

/**
 * Extract ss and bs values from PEF name
 * Example: "llama-3p1-70b-ss4096-bs1-sd9" -> ss: 4096, bs: 1
 */
function parsePefName(pefName: string): { ss: number; bs: number } | null {
  // Match pattern: ss followed by digits, bs followed by digits
  const ssMatch = pefName.match(/ss(\d+)/);
  const bsMatch = pefName.match(/bs(\d+)/);

  if (!ssMatch || !bsMatch) {
    console.warn(`Warning: Could not parse PEF name: ${pefName}`);
    return null;
  }

  return {
    ss: parseInt(ssMatch[1], 10),
    bs: parseInt(bsMatch[1], 10),
  };
}

/**
 * Convert ss value to "Xk" format if >= 1024, otherwise return as-is
 */
function formatSsValue(ss: number): string {
  if (ss < 1024) {
    return ss.toString();
  }
  const ssInK = ss / 1024;
  return `${ssInK}k`;
}

/**
 * Get the latest version number from PEF versions object
 * Parses the versions object and returns the highest version number
 */
function getLatestVersionFromVersions(versions: Record<string, unknown> | undefined): string {
  if (!versions || typeof versions !== 'object') {
    return '1'; // Default to version 1
  }

  try {
    // Extract all version numbers as integers
    const versionNumbers = Object.keys(versions)
      .map((v) => parseInt(v, 10))
      .filter((v) => !isNaN(v));

    if (versionNumbers.length === 0) {
      return '1';
    }

    // Find the maximum version
    const latestVersion = Math.max(...versionNumbers);
    return latestVersion.toString();
  } catch (error) {
    console.warn('Warning: Failed to parse versions:', error);
    return '1'; // Default to version 1 on error
  }
}

/**
 * Select SS values for a DYT PEF using the halving strategy.
 * Starts from max, halves until below min, keeps only values present in
 * the valid set (range(min, max, step)), then discards values < 32k (32768).
 */
function selectDytSsValues(ssMin: number, ssMax: number, ssStep: number): number[] {
  const validSsSet = new Set<number>();
  for (let ss = ssMin; ss <= ssMax; ss += ssStep) {
    validSsSet.add(ss);
  }

  const selected: number[] = [];
  let current = ssMax;
  while (current >= ssMin) {
    if (validSsSet.has(current)) {
      selected.push(current);
    }
    current = Math.floor(current / 2);
  }

  return selected.filter((ss) => ss >= 32768);
}

/**
 * Generate PEF configs and write to app/data/pef_configs.json
 * Returns object with success status and PEF count, or null if skipped/failed
 */
export async function generatePefConfigs(): Promise<{ success: true; count: number } | { success: false; error?: string }> {
  try {
    console.log('[PEF Generator] Checking for app-config.json...');

    // Read app-config.json to get current kubeconfig and namespace
    const configPath = path.join(process.cwd(), 'app-config.json');
    if (!existsSync(configPath)) {
      console.log('[PEF Generator] app-config.json not found. Skipping PEF config generation.');
      return { success: false, error: 'app-config.json not found' };
    }

    const configContent = readFileSync(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);

    const currentEnv = config.currentKubeconfig;
    if (!currentEnv || !config.kubeconfigs[currentEnv]) {
      console.log('[PEF Generator] No active environment configured. Skipping PEF config generation.');
      return { success: false, error: 'No active environment configured' };
    }

    const kubeconfigFile = config.kubeconfigs[currentEnv].file;
    const namespace = config.kubeconfigs[currentEnv].namespace || 'default';

    const kubeconfigPath = path.join(process.cwd(), kubeconfigFile);
    if (!existsSync(kubeconfigPath)) {
      console.log(`[PEF Generator] Kubeconfig file not found: ${kubeconfigFile}. Skipping PEF config generation.`);
      return { success: false, error: `Kubeconfig file not found: ${kubeconfigFile}` };
    }

    console.log(`[PEF Generator] Using environment: ${currentEnv}`);
    console.log(`[PEF Generator] Using namespace: ${namespace}`);
    console.log(`[PEF Generator] Running kubectl get pef -o json...`);

    // Run single kubectl command to get all PEFs with their data in JSON format
    const kubectlOutput = execSync(`kubectl -n ${namespace} get pef -o json`, {
      encoding: 'utf-8',
      env: { ...process.env, KUBECONFIG: kubeconfigPath },
      maxBuffer: 100 * 1024 * 1024, // 100MB to handle large PEF lists
    });

    // Parse JSON output
    const pefData: KubectlPefResponse = JSON.parse(kubectlOutput);
    const items = pefData.items || [];

    console.log(`[PEF Generator] Found ${items.length} PEFs`);
    console.log(`[PEF Generator] Processing PEFs...`);

    // Generate configs from the JSON data
    const configs: PefConfigs = {};
    let processedCount = 0;

    for (const item of items) {
      const pefName = item.metadata?.name;

      if (!pefName) {
        continue;
      }

      const versions = item.spec?.versions;
      const latestVersion = getLatestVersionFromVersions(versions);

      // DYT PEFs have dynamic batch sizes and SS derived from dynamic_dims
      const isDyt = pefName.includes('dyt');

      if (isDyt) {
        // For DYT PEFs, fetch individual PEF details since list output may not include dynamic_dims
        try {
          const individualOutput = execSync(`kubectl -n ${namespace} get pef ${pefName} -o json`, {
            encoding: 'utf-8',
            env: { ...process.env, KUBECONFIG: kubeconfigPath },
            maxBuffer: 2 * 1024 * 1024, // 100MB to handle large PEF output
          });
          const individualPef: KubectlPefItem = JSON.parse(individualOutput);
          const dynamicDims = individualPef.spec?.metadata?.dynamic_dims;
          const batchSizeValues = dynamicDims?.batch_size?.values;
          const ssMax = dynamicDims?.decode_seq?.max;
          const ssMin = dynamicDims?.decode_seq?.min;
          const ssStep = dynamicDims?.decode_seq?.step;
          const dytLatestVersion = getLatestVersionFromVersions(individualPef.spec?.versions);

          if (batchSizeValues && batchSizeValues.length > 0 && ssMax !== undefined) {
            let selectedSsValues: number[];
            if (ssMin !== undefined && ssStep !== undefined) {
              selectedSsValues = selectDytSsValues(ssMin, ssMax, ssStep);
            } else {
              selectedSsValues = [ssMax];
            }

            if (selectedSsValues.length === 0) {
              console.warn(`[PEF Generator] DYT PEF ${pefName} has no selected SS values after filtering, skipping`);
            } else {
              configs[pefName] = selectedSsValues.flatMap((ss) =>
                batchSizeValues.map((bs) => ({
                  ss: formatSsValue(ss),
                  bs: bs.toString(),
                  latestVersion: dytLatestVersion,
                }))
              );
              processedCount++;
            }
          } else {
            console.warn(`[PEF Generator] DYT PEF ${pefName} missing dynamic_dims data, skipping`);
          }
        } catch (err) {
          console.warn(`[PEF Generator] Failed to get details for DYT PEF ${pefName}:`, err);
        }
      } else {
        const parsed = parsePefName(pefName);

        if (parsed) {
          configs[pefName] = {
            ss: formatSsValue(parsed.ss),
            bs: parsed.bs.toString(),
            latestVersion,
          };
          processedCount++;
        }
      }
    }

    console.log(`[PEF Generator] ✓ Processed ${processedCount}/${items.length} PEFs`);

    // Apply DYT precedence logic (DYT is always enabled)
    const pefMappingPath = path.join(process.cwd(), 'app', 'data', 'pef_mapping.json');
    if (!existsSync(pefMappingPath)) {
      return {
        success: false,
        error: 'pef_mapping.json was not found in the app/data folder! Please restore the file and reapply the environment configuration.',
      };
    }
    const dytEnabled = true;
    const pefMapping: Record<string, string[]> = JSON.parse(readFileSync(pefMappingPath, 'utf-8'));
    for (const pefNames of Object.values(pefMapping)) {
      const hasDyt = pefNames.some((name) => name.includes('dyt') && configs[name] !== undefined);
      if (hasDyt) {
        for (const pefName of pefNames) {
          if (dytEnabled ? !pefName.includes('dyt') : pefName.includes('dyt')) {
            delete configs[pefName];
          }
        }
      }
    }

    // Detect embedding (and other typed) models and update checkpoint_mapping.json
    const checkpointMappingPath = path.join(process.cwd(), 'app', 'data', 'checkpoint_mapping.json');
    if (existsSync(checkpointMappingPath)) {
      const checkpointMapping: Record<string, Record<string, unknown>> = JSON.parse(
        readFileSync(checkpointMappingPath, 'utf-8')
      );
      let checkpointMappingUpdated = false;

      // spec.metadata is not included in list responses — fetch one PEF per model individually
      for (const [modelName, pefNames] of Object.entries(pefMapping)) {
        if (!checkpointMapping[modelName]) continue;
        if (checkpointMapping[modelName].model_type) continue; // already set

        // Find the first PEF for this model that exists in the cluster
        const representativePef = pefNames.find((name) => items.some((item) => item.metadata?.name === name));
        if (!representativePef) continue;

        try {
          const individualOutput = execSync(`kubectl -n ${namespace} get pef ${representativePef} -o json`, {
            encoding: 'utf-8',
            env: { ...process.env, KUBECONFIG: kubeconfigPath },
            maxBuffer: 2 * 1024 * 1024,
          });
          const individualPef: KubectlPefItem = JSON.parse(individualOutput);
          const taskName = individualPef.spec?.metadata?.task_name;
          if (taskName) {
            checkpointMapping[modelName].model_type = taskName;
            checkpointMappingUpdated = true;
            console.log(`[PEF Generator] Set model_type="${taskName}" for ${modelName}`);
          }
        } catch (err) {
          console.warn(`[PEF Generator] Failed to get task_name for ${modelName}:`, err);
        }
      }

      if (checkpointMappingUpdated) {
        writeFileSync(checkpointMappingPath, JSON.stringify(checkpointMapping, null, 2), 'utf-8');
        console.log('[PEF Generator] ✓ Updated checkpoint_mapping.json with model_type fields');
      }
    }

    // Write to file
    const outputPath = path.join(process.cwd(), 'app', 'data', 'pef_configs.json');
    writeFileSync(outputPath, JSON.stringify(configs, null, 2), 'utf-8');

    const configCount = Object.keys(configs).length;
    console.log(`[PEF Generator] ✓ Generated pef_configs.json with ${configCount} entries`);
    return { success: true, count: configCount };
  } catch (error) {
    console.error('[PEF Generator] Error generating PEF configs:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

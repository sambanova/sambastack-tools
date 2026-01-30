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
  [key: string]: PefConfig;
}

interface KubectlPefItem {
  metadata?: {
    name?: string;
  };
  spec?: {
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

      const parsed = parsePefName(pefName);

      if (parsed) {
        // Extract versions from spec.versions
        const versions = item.spec?.versions;
        const latestVersion = getLatestVersionFromVersions(versions);

        configs[pefName] = {
          ss: formatSsValue(parsed.ss),
          bs: parsed.bs.toString(),
          latestVersion,
        };
        processedCount++;
      }
    }

    console.log(`[PEF Generator] ✓ Processed ${processedCount}/${items.length} PEFs`);

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

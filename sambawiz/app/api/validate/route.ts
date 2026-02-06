import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  apiKey?: string;
}

interface AppConfig {
  checkpointsDir: string;
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

/**
 * Extract bundle name from YAML content
 */
function extractBundleName(yaml: string): string | null {
  const lines = yaml.split('\n');
  let inBundleSection = false;

  for (const line of lines) {
    // Check if we're in the Bundle section (not BundleTemplate)
    if (line.includes('kind: Bundle') && !line.includes('kind: BundleTemplate')) {
      inBundleSection = true;
      continue;
    }

    // Look for metadata.name in the Bundle section
    if (inBundleSection && line.includes('name:')) {
      const match = line.match(/name:\s*(.+)/);
      if (match) {
        return match[1].trim();
      }
    }

    // Reset if we hit another resource separator
    if (line.trim() === '---') {
      inBundleSection = false;
    }
  }

  return null;
}

/**
 * Extract validation status from kubectl JSON output
 */
interface BundleCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

interface BundleStatus {
  status?: {
    conditions?: BundleCondition[];
  };
}

function extractValidationStatus(jsonOutput: string): {
  reason: string;
  message: string;
  isValid: boolean;
} {
  try {
    const bundle: BundleStatus = JSON.parse(jsonOutput);

    if (!bundle.status?.conditions || bundle.status.conditions.length === 0) {
      return {
        reason: 'Unknown',
        message: 'No validation conditions found in bundle status',
        isValid: false,
      };
    }

    // Get the first condition (typically the validation result)
    const condition = bundle.status.conditions[0];

    return {
      reason: condition.reason || 'Unknown',
      message: condition.message || 'No message provided',
      isValid: condition.reason === 'ValidationSucceeded' || condition.status === 'True',
    };
  } catch (error) {
    return {
      reason: 'ParseError',
      message: `Failed to parse bundle status: ${error instanceof Error ? error.message : 'Unknown error'}`,
      isValid: false,
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { yaml } = body;

    if (!yaml || typeof yaml !== 'string') {
      return NextResponse.json(
        { error: 'Invalid YAML content' },
        { status: 400 }
      );
    }

    // Extract bundle name from YAML
    const bundleName = extractBundleName(yaml);
    if (!bundleName) {
      return NextResponse.json(
        { error: 'Could not extract bundle name from YAML' },
        { status: 400 }
      );
    }

    // Save YAML to temporary file
    const timestamp = Date.now();
    const fileName = `bundle-${timestamp}.yaml`;
    const filePath = path.join(process.cwd(), 'temp', fileName);

    // Ensure temp directory exists
    const tempDir = path.join(process.cwd(), 'temp');
    try {
      execSync(`mkdir -p "${tempDir}"`);
    } catch {
      // Directory might already exist
    }

    // Write YAML to file
    writeFileSync(filePath, yaml, 'utf-8');

    // Read app-config.json to get current kubeconfig and namespace
    const configPath = path.join(process.cwd(), 'app-config.json');
    if (!existsSync(configPath)) {
      return NextResponse.json(
        { error: 'app-config.json not found. Please configure an environment first.' },
        { status: 400 }
      );
    }

    const configContent = readFileSync(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);

    const currentEnv = config.currentKubeconfig;
    if (!currentEnv || !config.kubeconfigs[currentEnv]) {
      return NextResponse.json(
        { error: 'No active environment configured. Please select an environment first.' },
        { status: 400 }
      );
    }

    const kubeconfigFile = config.kubeconfigs[currentEnv].file;
    const namespace = config.kubeconfigs[currentEnv].namespace || 'default';

    // Set KUBECONFIG environment variable
    const kubeconfigPath = path.join(process.cwd(), kubeconfigFile);
    if (!existsSync(kubeconfigPath)) {
      return NextResponse.json(
        { error: `Kubeconfig file not found: ${kubeconfigFile}` },
        { status: 400 }
      );
    }

    const env = { ...process.env, KUBECONFIG: kubeconfigPath };

    let applyOutput = '';
    try {
      // Run kubectl apply
      applyOutput = execSync(`kubectl -n ${namespace} apply -f "${filePath}"`, {
        encoding: 'utf-8',
        env,
        timeout: 30000, // 30 second timeout
      });

      // Clean up temp file after successful apply
      try {
        unlinkSync(filePath);
      } catch (cleanupError) {
        console.warn('Failed to delete temp file:', filePath, cleanupError);
      }
    } catch (error) {
      // kubectl apply failed - clean up temp file before returning
      try {
        unlinkSync(filePath);
      } catch (cleanupError) {
        console.warn('Failed to delete temp file:', filePath, cleanupError);
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';
      const stdout = (error && typeof error === 'object' && 'stdout' in error)
        ? String(error.stdout)
        : '';
      return NextResponse.json(
        {
          success: false,
          error: 'kubectl apply failed',
          message,
          stderr,
          stdout,
          filePath,
        },
        { status: 400 }
      );
    }

    // Wait 5 seconds for bundle to be processed
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get bundle status using JSON output
    let validationStatus;
    try {
      const jsonOutput = execSync(`kubectl -n ${namespace} get bundle.sambanova.ai ${bundleName} -o json`, {
        encoding: 'utf-8',
        env,
        timeout: 30000,
      });

      validationStatus = extractValidationStatus(jsonOutput);
    } catch (error) {
      // kubectl get bundle.sambanova.ai failed
      const stderr = (error && typeof error === 'object' && 'stderr' in error)
        ? String(error.stderr)
        : '';
      const stdout = (error && typeof error === 'object' && 'stdout' in error)
        ? String(error.stdout)
        : '';
      return NextResponse.json(
        {
          success: false,
          error: 'kubectl get bundle.sambanova.ai failed',
          message: 'Bundle was applied but status check failed',
          applyOutput: applyOutput.trim(),
          stderr,
          stdout,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      message: validationStatus.isValid
        ? 'Bundle validation succeeded!'
        : 'Bundle validation failed',
      applyOutput: applyOutput.trim(),
      validationStatus,
      bundleName,
      filePath,
    });
  } catch (error) {
    console.error('Validation error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

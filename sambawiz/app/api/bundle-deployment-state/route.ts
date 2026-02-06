import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

interface BundleDeploymentState {
  selectedBundle: string;
  deploymentName: string;
  deploymentYaml: string;
  monitoredDeployment: string;
  environment: string;
}

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

const STATE_FILE_PATH = path.join(process.cwd(), 'temp', 'bundle-deployment-state.json');

/**
 * GET - Load the saved bundle deployment state
 */
export async function GET() {
  try {
    // Ensure temp directory exists
    const tempDir = path.join(process.cwd(), 'temp');
    try {
      execSync(`mkdir -p "${tempDir}"`);
    } catch {
      // Directory might already exist
    }

    // Check if state file exists
    if (!existsSync(STATE_FILE_PATH)) {
      return NextResponse.json({
        success: true,
        state: null,
        message: 'No saved state found',
      });
    }

    // Read the state file
    const stateContent = readFileSync(STATE_FILE_PATH, 'utf-8');
    const state: BundleDeploymentState = JSON.parse(stateContent);

    // Read app-config.json to get current environment
    const configPath = path.join(process.cwd(), 'app-config.json');
    if (!existsSync(configPath)) {
      // No config, clear state and return null
      execSync(`rm "${STATE_FILE_PATH}"`);
      return NextResponse.json({
        success: true,
        state: null,
        message: 'No app config found, cleared state',
      });
    }

    const configContent = readFileSync(configPath, 'utf-8');
    const config: AppConfig = JSON.parse(configContent);

    const currentEnv = config.currentKubeconfig;
    if (!currentEnv || !config.kubeconfigs[currentEnv]) {
      // No active environment, clear state and return null
      execSync(`rm "${STATE_FILE_PATH}"`);
      return NextResponse.json({
        success: true,
        state: null,
        message: 'No active environment, cleared state',
      });
    }

    // Check if environment matches
    if (state.environment !== currentEnv) {
      // Environment mismatch, clear state and return null
      execSync(`rm "${STATE_FILE_PATH}"`);
      return NextResponse.json({
        success: true,
        state: null,
        message: 'Environment changed, cleared state',
      });
    }

    // Environment matches, now check if the deployment still exists
    if (state.monitoredDeployment) {
      const kubeconfigFile = config.kubeconfigs[currentEnv].file;
      const namespace = config.kubeconfigs[currentEnv].namespace || 'default';
      const kubeconfigPath = path.join(process.cwd(), kubeconfigFile);

      if (!existsSync(kubeconfigPath)) {
        // Kubeconfig doesn't exist, clear state and return null
        execSync(`rm "${STATE_FILE_PATH}"`);
        return NextResponse.json({
          success: true,
          state: null,
          message: 'Kubeconfig not found, cleared state',
        });
      }

      const env = { ...process.env, KUBECONFIG: kubeconfigPath };

      try {
        // Check if the deployment exists
        execSync(
          `kubectl -n ${namespace} get bundledeployment.sambanova.ai ${state.monitoredDeployment} -o name`,
          {
            encoding: 'utf-8',
            env,
            timeout: 10000,
            stdio: 'pipe', // Suppress output
          }
        );
        // Deployment exists, return the state
      } catch {
        // Deployment doesn't exist, clear state and return null
        execSync(`rm "${STATE_FILE_PATH}"`);
        return NextResponse.json({
          success: true,
          state: null,
          message: 'Deployment no longer exists, cleared state',
        });
      }
    }

    return NextResponse.json({
      success: true,
      state,
    });
  } catch (error) {
    console.error('Error loading bundle deployment state:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to load state',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST - Save the bundle deployment state
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { state } = body;

    if (!state) {
      return NextResponse.json(
        { error: 'Invalid state data' },
        { status: 400 }
      );
    }

    // Read app-config.json to get current environment
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

    // Add current environment to state
    const stateWithEnvironment: BundleDeploymentState = {
      ...state,
      environment: currentEnv,
    };

    // Ensure temp directory exists
    const tempDir = path.join(process.cwd(), 'temp');
    try {
      execSync(`mkdir -p "${tempDir}"`);
    } catch {
      // Directory might already exist
    }

    // Write state to file
    writeFileSync(STATE_FILE_PATH, JSON.stringify(stateWithEnvironment, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Bundle deployment state saved successfully',
    });
  } catch (error) {
    console.error('Error saving bundle deployment state:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to save state',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Clear the saved bundle deployment state
 */
export async function DELETE() {
  try {
    if (existsSync(STATE_FILE_PATH)) {
      execSync(`rm "${STATE_FILE_PATH}"`);
    }

    return NextResponse.json({
      success: true,
      message: 'Bundle deployment state cleared successfully',
    });
  } catch (error) {
    console.error('Error clearing bundle deployment state:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to clear state',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

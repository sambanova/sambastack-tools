import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

interface BundleBuilderState {
  selectedModels: string[];
  selectedConfigs: Array<{
    modelName: string;
    ss: string;
    bs: string;
    pefName: string;
  }>;
  bundleName: string;
  generatedYaml: string;
  draftModels: { [modelName: string]: string };
  savedAt?: string;
  cluster?: { kubeconfig: string; namespace: string };
}

const STATE_FILE_PATH = path.join(process.cwd(), 'temp', 'model-selection-state.json');

interface KubeconfigEntry {
  namespace: string;
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, KubeconfigEntry>;
}

/**
 * The environment the state was saved against. A bundle built for one cluster
 * names profiles another may not have, so a restore has to say where the state
 * came from.
 */
function currentCluster(): { kubeconfig: string; namespace: string } {
  try {
    const config: AppConfig = JSON.parse(
      readFileSync(path.join(process.cwd(), 'app-config.json'), 'utf-8')
    );
    const name = config.currentKubeconfig ?? '';
    return { kubeconfig: name, namespace: config.kubeconfigs?.[name]?.namespace || 'default' };
  } catch {
    return { kubeconfig: '', namespace: '' };
  }
}

/**
 * GET - Load the saved bundle builder state
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
    const state: BundleBuilderState = JSON.parse(stateContent);

    return NextResponse.json({
      success: true,
      state,
    });
  } catch (error) {
    console.error('Error loading bundle builder state:', error);
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
 * POST - Save the bundle builder state
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

    // Ensure temp directory exists
    const tempDir = path.join(process.cwd(), 'temp');
    try {
      execSync(`mkdir -p "${tempDir}"`);
    } catch {
      // Directory might already exist
    }

    // Stamp the save with its time and cluster, so a restore can tell the user
    // what they are about to bring back.
    const stamped = { ...state, savedAt: new Date().toISOString(), cluster: currentCluster() };
    writeFileSync(STATE_FILE_PATH, JSON.stringify(stamped, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Bundle builder state saved successfully',
    });
  } catch (error) {
    console.error('Error saving bundle builder state:', error);
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
 * DELETE - Clear the saved bundle builder state
 */
export async function DELETE() {
  try {
    if (existsSync(STATE_FILE_PATH)) {
      execSync(`rm "${STATE_FILE_PATH}"`);
    }

    return NextResponse.json({
      success: true,
      message: 'Bundle builder state cleared successfully',
    });
  } catch (error) {
    console.error('Error clearing bundle builder state:', error);
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

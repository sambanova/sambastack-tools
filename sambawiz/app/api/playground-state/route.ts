import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

interface PodStatusInfo {
  ready: number;
  total: number;
  status: string;
}

interface BundleDeployment {
  name: string;
  namespace: string;
  bundle: string;
  creationTimestamp: string;
}

interface PlaygroundState {
  environment: string;
  bundleDeployments: BundleDeployment[];
  deploymentStatuses: Record<string, { cachePod: PodStatusInfo | null; defaultPod: PodStatusInfo | null }>;
  selectedDeployment: string;
  availableModels: string[];
  selectedModel: string;
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

const STATE_FILE_PATH = path.join(process.cwd(), 'temp', 'playground-state.json');

function ensureTempDir() {
  const tempDir = path.join(process.cwd(), 'temp');
  try {
    execSync(`mkdir -p "${tempDir}"`);
  } catch {
    // Directory might already exist
  }
}

function getCurrentEnv(): string | null {
  const configPath = path.join(process.cwd(), 'app-config.json');
  if (!existsSync(configPath)) return null;
  try {
    const config: AppConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    const env = config.currentKubeconfig;
    if (!env || !config.kubeconfigs?.[env]) return null;
    return env;
  } catch {
    return null;
  }
}

/**
 * GET - Load the saved playground state
 */
export async function GET() {
  try {
    ensureTempDir();

    if (!existsSync(STATE_FILE_PATH)) {
      return NextResponse.json({ success: true, state: null });
    }

    const stateContent = readFileSync(STATE_FILE_PATH, 'utf-8');
    const state: PlaygroundState = JSON.parse(stateContent);

    const currentEnv = getCurrentEnv();
    if (!currentEnv) {
      unlinkSync(STATE_FILE_PATH);
      return NextResponse.json({ success: true, state: null, message: 'No active environment, cleared state' });
    }

    if (state.environment !== currentEnv) {
      unlinkSync(STATE_FILE_PATH);
      return NextResponse.json({ success: true, state: null, message: 'Environment changed, cleared state' });
    }

    return NextResponse.json({ success: true, state });
  } catch (error) {
    console.error('Error loading playground state:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load state' },
      { status: 500 }
    );
  }
}

/**
 * POST - Save the playground state
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { state } = body;

    if (!state) {
      return NextResponse.json({ error: 'Invalid state data' }, { status: 400 });
    }

    const currentEnv = getCurrentEnv();
    if (!currentEnv) {
      return NextResponse.json(
        { error: 'No active environment configured. Please select an environment first.' },
        { status: 400 }
      );
    }

    const stateWithEnv: PlaygroundState = { ...state, environment: currentEnv };

    ensureTempDir();
    writeFileSync(STATE_FILE_PATH, JSON.stringify(stateWithEnv, null, 2), 'utf-8');

    return NextResponse.json({ success: true, message: 'Playground state saved successfully' });
  } catch (error) {
    console.error('Error saving playground state:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to save state' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Clear the saved playground state
 */
export async function DELETE() {
  try {
    if (existsSync(STATE_FILE_PATH)) {
      unlinkSync(STATE_FILE_PATH);
    }
    return NextResponse.json({ success: true, message: 'Playground state cleared successfully' });
  } catch (error) {
    console.error('Error clearing playground state:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to clear state' },
      { status: 500 }
    );
  }
}

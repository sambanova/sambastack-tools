import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import {
  environmentStorageError,
  readEnvironmentStorage,
  validateDeploymentStorage,
  type DeploymentStorage,
} from '@/app/utils/deployment-storage';

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: Record<string, { storage?: unknown }>;
}

/**
 * The air-gapped `spec.storage` last deployed for each bundle / model, per
 * environment: `{ [env]: { [sourceKey]: DeploymentStorage } }`. The source key
 * is `bundle:<ModelBundle name>` or `model:<model ref>` (see
 * `deploymentSourceKey` in ModelDeploymentManager). Selecting the same bundle
 * or model again on the Model Deployment page restores the block.
 */
type StorageState = Record<string, Record<string, DeploymentStorage>>;

const STATE_FILE_PATH = path.join(process.cwd(), 'temp', 'deployment-storage-state.json');

/** The active environment's name and app-config.json entry, or null when there is none. */
function currentEnvironmentEntry(): { env: string; entry: { storage?: unknown } } | null {
  const configPath = path.join(process.cwd(), 'app-config.json');
  if (!existsSync(configPath)) return null;
  const config: AppConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  const env = config.currentKubeconfig;
  const entry = env ? config.kubeconfigs?.[env] : undefined;
  return env && entry ? { env, entry } : null;
}

/** The active environment from app-config.json, or null when there is none. */
function currentEnvironment(): string | null {
  return currentEnvironmentEntry()?.env ?? null;
}

function readState(): StorageState {
  if (!existsSync(STATE_FILE_PATH)) return {};
  try {
    const state = JSON.parse(readFileSync(STATE_FILE_PATH, 'utf-8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    // A corrupt file only loses the remembered blocks; start over.
    return {};
  }
}

/**
 * GET - The remembered storage blocks for the current environment, plus the
 * environment's own `storage` from app-config.json (`kubeconfigs.<env>.storage`,
 * the block the CLI uses). The page falls back to the latter for bundles /
 * models with nothing remembered. An invalid environment block is reported
 * in `environmentStorageError` and never returned.
 */
export async function GET() {
  try {
    const current = currentEnvironmentEntry();
    if (!current) {
      return NextResponse.json({ success: true, storage: {}, environmentStorage: null, environmentStorageError: null });
    }
    return NextResponse.json({
      success: true,
      storage: readState()[current.env] ?? {},
      environmentStorage: readEnvironmentStorage(current.entry),
      environmentStorageError: environmentStorageError(current.entry),
    });
  } catch (error) {
    console.error('Error loading deployment storage state:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to load deployment storage state',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST - Remember (`storage` set) or forget (`storage: null`) the storage
 * block for one bundle / model in the current environment
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const key = body?.key;
    if (!key || typeof key !== 'string' || !/^(bundle|model):\S+$/.test(key)) {
      return NextResponse.json(
        { success: false, error: 'key must be "bundle:<name>" or "model:<ref>"' },
        { status: 400 }
      );
    }

    let storage: DeploymentStorage | null = null;
    if (body.storage !== null) {
      const result = validateDeploymentStorage(body.storage);
      if (!result.valid) {
        return NextResponse.json(
          { success: false, error: `Invalid air-gapped storage: ${result.error}` },
          { status: 400 }
        );
      }
      storage = result.storage;
    }

    const env = currentEnvironment();
    if (!env) {
      return NextResponse.json(
        { success: false, error: 'No active environment configured. Please select an environment first.' },
        { status: 400 }
      );
    }

    const state = readState();
    const envState = { ...(state[env] ?? {}) };
    if (storage) envState[key] = storage;
    else delete envState[key];
    state[env] = envState;

    mkdirSync(path.dirname(STATE_FILE_PATH), { recursive: true });
    writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error saving deployment storage state:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to save deployment storage state',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

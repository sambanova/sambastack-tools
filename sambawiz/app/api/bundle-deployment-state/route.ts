import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

interface BundleDeploymentState {
  selectedBundle: string;
  deploymentName: string;
  deploymentYaml: string;
  monitoredDeployment: string;
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

    // Ensure temp directory exists
    const tempDir = path.join(process.cwd(), 'temp');
    try {
      execSync(`mkdir -p "${tempDir}"`);
    } catch {
      // Directory might already exist
    }

    // Write state to file
    writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');

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

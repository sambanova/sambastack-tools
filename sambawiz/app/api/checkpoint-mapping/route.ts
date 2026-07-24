import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Reads the optional `checkpoint_overrides` map from app-config.json — a
 * `{ <model display name>: <checkpoint version> }` map used to pin a specific
 * checkpoint version (instead of the latest) when building model refs. Returns
 * an empty map when unset or unreadable.
 */
async function readCheckpointOverrides(): Promise<Record<string, string>> {
  try {
    const configPath = path.join(process.cwd(), 'app-config.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    const overrides = config?.checkpoint_overrides;
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
      return overrides as Record<string, string>;
    }
  } catch {
    // Config missing or malformed — treat as no overrides.
  }
  return {};
}

export async function GET() {
  try {
    const checkpointMappingPath = path.join(process.cwd(), 'app/data/checkpoint_mapping.json');
    const checkpointOverrides = await readCheckpointOverrides();

    try {
      const fileContent = await fs.readFile(checkpointMappingPath, 'utf-8');
      const checkpointMapping = JSON.parse(fileContent);
      return NextResponse.json({
        success: true,
        data: checkpointMapping,
        checkpointOverrides,
      });
    } catch {
      // File doesn't exist (gitignored) - return empty mapping
      return NextResponse.json({
        success: true,
        data: {},
        checkpointOverrides,
      });
    }
  } catch (error) {
    console.error('Error loading checkpoint mapping:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to load checkpoint mapping file',
      data: {},
      checkpointOverrides: {},
    });
  }
}

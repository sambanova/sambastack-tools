import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Serves the `model_profiles.json` cache (written by
 * `/api/generate-model-profiles` during the Home "Apply" flow) to the
 * client, mirroring `/api/checkpoint-mapping`'s read/passthrough pattern.
 * The file is cluster-generated and gitignored, so it may not exist yet.
 */
export async function GET() {
  try {
    const modelProfilesPath = path.join(process.cwd(), 'app/data/model_profiles.json');

    try {
      const fileContent = await fs.readFile(modelProfilesPath, 'utf-8');
      const modelProfiles = JSON.parse(fileContent);
      return NextResponse.json({
        success: true,
        data: modelProfiles,
      });
    } catch {
      // File doesn't exist (gitignored) - return empty mapping
      return NextResponse.json({
        success: true,
        data: {},
      });
    }
  } catch (error) {
    console.error('Error loading model profiles:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to load model profiles file',
      data: {},
    });
  }
}

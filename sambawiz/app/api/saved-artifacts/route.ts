import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const savedArtifactsDir = path.join(process.cwd(), 'saved_artifacts');

    // Check if directory exists
    if (!fs.existsSync(savedArtifactsDir)) {
      return NextResponse.json({
        success: true,
        files: []
      });
    }

    // Read all files in the directory
    const allFiles = fs.readdirSync(savedArtifactsDir);

    // Filter for .yaml files that contain a ModelBundle document (v3 surface;
    // V2 BundleTemplate+Bundle saves are no longer recognized, per Q9 — no
    // backwards compatibility).
    const yamlFiles = allFiles
      .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'))
      .filter(file => {
        try {
          const filePath = path.join(savedArtifactsDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');

          return content.includes('kind: ModelBundle');
        } catch (err) {
          console.error(`Error reading file ${file}:`, err);
          return false;
        }
      })
      .sort();

    return NextResponse.json({
      success: true,
      files: yamlFiles
    });

  } catch (error) {
    console.error('Error reading saved artifacts:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to read saved artifacts',
      files: []
    }, { status: 500 });
  }
}

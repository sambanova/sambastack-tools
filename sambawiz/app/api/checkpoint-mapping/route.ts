import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const checkpointMappingPath = path.join(process.cwd(), 'app/data/checkpoint_mapping.json');

    try {
      const fileContent = await fs.readFile(checkpointMappingPath, 'utf-8');
      const checkpointMapping = JSON.parse(fileContent);
      return NextResponse.json({
        success: true,
        data: checkpointMapping,
      });
    } catch (error) {
      // File doesn't exist (gitignored) - return empty mapping
      return NextResponse.json({
        success: true,
        data: {},
      });
    }
  } catch (error) {
    console.error('Error loading checkpoint mapping:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to load checkpoint mapping file',
      data: {},
    });
  }
}

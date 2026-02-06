import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export async function GET() {
  try {
    const checkpointMappingPath = path.join(process.cwd(), 'app/data/checkpoint_mapping.json');

    try {
      await fs.access(checkpointMappingPath);
      return NextResponse.json({
        success: true,
        exists: true,
      });
    } catch {
      return NextResponse.json({
        success: true,
        exists: false,
      });
    }
  } catch (error) {
    console.error('Error checking checkpoint mapping:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to check checkpoint mapping file',
    });
  }
}

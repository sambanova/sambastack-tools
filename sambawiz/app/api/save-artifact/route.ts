import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export async function POST(request: NextRequest) {
  try {
    const { fileName, content } = await request.json();

    if (!fileName || !content) {
      return NextResponse.json(
        { success: false, error: 'Missing fileName or content' },
        { status: 400 }
      );
    }

    const savedArtifactsDir = join(process.cwd(), 'saved_artifacts');

    // Create saved_artifacts directory if it doesn't exist
    if (!existsSync(savedArtifactsDir)) {
      mkdirSync(savedArtifactsDir, { recursive: true });
    }

    const filePath = join(savedArtifactsDir, fileName);

    // Check if file already exists
    const fileExists = existsSync(filePath);

    if (fileExists) {
      return NextResponse.json(
        { success: false, error: 'File already exists', fileExists: true },
        { status: 409 }
      );
    }

    // Save the file
    writeFileSync(filePath, content, 'utf8');

    return NextResponse.json({
      success: true,
      message: `File saved successfully: ${fileName}`,
      filePath,
    });
  } catch (error) {
    console.error('Save artifact error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to save file' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { fileName, content } = await request.json();

    if (!fileName || !content) {
      return NextResponse.json(
        { success: false, error: 'Missing fileName or content' },
        { status: 400 }
      );
    }

    const savedArtifactsDir = join(process.cwd(), 'saved_artifacts');

    // Create saved_artifacts directory if it doesn't exist
    if (!existsSync(savedArtifactsDir)) {
      mkdirSync(savedArtifactsDir, { recursive: true });
    }

    const filePath = join(savedArtifactsDir, fileName);

    // Overwrite the file
    writeFileSync(filePath, content, 'utf8');

    return NextResponse.json({
      success: true,
      message: `File overwritten successfully: ${fileName}`,
      filePath,
    });
  } catch (error) {
    console.error('Overwrite artifact error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to overwrite file' },
      { status: 500 }
    );
  }
}

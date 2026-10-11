import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, existsSync } from 'fs';
import { ensureArtifactsDir, resolveArtifactPath } from '../../utils/artifacts-dir';

export async function POST(request: NextRequest) {
  try {
    const { fileName, content } = await request.json();

    if (!fileName || !content) {
      return NextResponse.json(
        { success: false, error: 'Missing fileName or content' },
        { status: 400 }
      );
    }

    ensureArtifactsDir();
    const filePath = resolveArtifactPath(fileName);

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'fileName must name a file inside the artifacts directory' },
        { status: 400 }
      );
    }

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

    ensureArtifactsDir();
    const filePath = resolveArtifactPath(fileName);

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'fileName must name a file inside the artifacts directory' },
        { status: 400 }
      );
    }

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

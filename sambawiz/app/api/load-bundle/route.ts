import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { parseBundleYamlContent } from '@/app/utils/parse-bundle-yaml';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const fileName = searchParams.get('fileName');

    if (!fileName) {
      return NextResponse.json({
        success: false,
        error: 'fileName parameter is required'
      }, { status: 400 });
    }

    const filePath = path.join(process.cwd(), 'saved_artifacts', fileName);

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({
        success: false,
        error: `File not found: ${fileName}`
      }, { status: 404 });
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const result = parseBundleYamlContent(fileContent);

    if ('error' in result) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, ...result });

  } catch (error) {
    console.error('Error loading bundle:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load bundle'
    }, { status: 500 });
  }
}

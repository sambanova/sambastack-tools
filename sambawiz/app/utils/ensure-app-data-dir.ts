import { existsSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * app/data is gitignored and has no tracked placeholder, so it doesn't exist
 * after a fresh clone. Call this before writing any file under it.
 */
export function ensureAppDataDir(): string {
  const dir = path.join(process.cwd(), 'app', 'data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

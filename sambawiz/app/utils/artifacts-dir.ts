import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Where SambaWiz saves and loads bundle and deployment YAML. Server-side only.
 *
 * `artifactsDir` in app-config.json sets it, so a site can point SambaWiz at a
 * directory its people already edit in and have saves, the saved-bundle list
 * and loading all agree. A relative value resolves against the SambaWiz
 * directory. The default keeps the historical `saved_artifacts` location.
 */

const DEFAULT_ARTIFACTS_DIR = 'saved_artifacts';

interface AppConfigWithArtifacts {
  artifactsDir?: string;
}

/** The configured directory, resolved to an absolute path. */
export function resolveArtifactsDir(): string {
  let configured = '';
  try {
    const config: AppConfigWithArtifacts = JSON.parse(
      readFileSync(path.join(process.cwd(), 'app-config.json'), 'utf-8')
    );
    configured = typeof config.artifactsDir === 'string' ? config.artifactsDir.trim() : '';
  } catch {
    configured = '';
  }

  const dir = configured.length > 0 ? configured : DEFAULT_ARTIFACTS_DIR;
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

/** The configured directory, created when it does not exist yet. */
export function ensureArtifactsDir(): string {
  const dir = resolveArtifactsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Resolves one artifact file inside the configured directory. A file name that
 * would land outside it is rejected, so a request cannot reach an arbitrary
 * path by way of `..` or a leading slash.
 */
export function resolveArtifactPath(fileName: string): string | null {
  const dir = resolveArtifactsDir();
  const resolved = path.resolve(dir, fileName);
  const withinDir = resolved === dir || resolved.startsWith(dir + path.sep);
  return withinDir ? resolved : null;
}

/**
 * Hands the browser a file to save. Where it lands is the browser's decision,
 * so this works the same whether SambaWiz runs on the machine you are sitting
 * at or on a remote node.
 */

/**
 * Turns a resource name into a YAML filename. Characters a filesystem treats
 * specially become a dash, so a name that is valid in Kubernetes but awkward on
 * disk still saves.
 */
export function toYamlFileName(name: string, fallback = 'bundle'): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  const base = cleaned.length > 0 ? cleaned : fallback;
  return base.endsWith('.yaml') || base.endsWith('.yml') ? base : `${base}.yaml`;
}

/** Saves `content` through the browser's download flow. */
export function downloadTextFile(fileName: string, content: string, mimeType = 'application/yaml'): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

/**
 * Optional `spec.storage` for a `ModelDeployment` (CUSTEI-1560).
 *
 * On an air-gapped SambaStack cluster there is no artifact registry, so the
 * inference pods must mount their checkpoints from a local/NFS path on the
 * node. That mount is the `spec.storage.hostPath` block, configured per
 * environment in app-config.json (`kubeconfigs.<env>.storage`). When an
 * environment has no `storage`, nothing is emitted and the generated YAML is
 * unchanged — online installs must never carry this block.
 *
 * Shared by the web UI (Home settings + Model Deployment page), the
 * update-config route, and the CLI so they all validate and emit it the same way.
 */

import yaml from 'js-yaml';

/** One `spec.storage.hostPath[]` entry, in the operator's own shape. */
export interface HostPathMount {
  /** Volume name (a Kubernetes volume name: lowercase RFC 1123 label). */
  name: string;
  /** Where the volume is mounted inside the pod. Must match the `local://` prefix in models.yaml. */
  mountPath: string;
  /** Directory on the node that holds the checkpoints. Cluster-specific — never defaulted. */
  path: string;
}

/** The `spec.storage` block. Only `hostPath` is supported by the operator today. */
export interface DeploymentStorage {
  hostPath: HostPathMount[];
}

/** Volume name pre-filled in the settings form. */
export const DEFAULT_STORAGE_VOLUME_NAME = 'nfs';

/** Mount path pre-filled in the settings form (the SambaStack air-gapped convention). */
export const DEFAULT_STORAGE_MOUNT_PATH = '/nfsdata';

/** Kubernetes volume names are RFC 1123 labels: lowercase alphanumerics and '-', at most 63 chars. */
const RFC_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const RFC_1123_LABEL_MAX_LENGTH = 63;

/** An absolute path with no whitespace. */
const ABSOLUTE_PATH = /^\/\S*$/;

/** Dump options matching the rest of SambaWiz's generated YAML. */
const DUMP_OPTIONS: yaml.DumpOptions = { lineWidth: -1, quotingType: '"' };

/**
 * Why a single mount is invalid, or `null` when it is valid. Messages name the
 * field so the settings form can show them as-is.
 */
export function validateHostPathMount(mount: Partial<HostPathMount>): string | null {
  const name = mount.name ?? '';
  const mountPath = mount.mountPath ?? '';
  const hostPath = mount.path ?? '';

  if (!name) return 'Volume name is required.';
  if (name.length > RFC_1123_LABEL_MAX_LENGTH || !RFC_1123_LABEL.test(name)) {
    return 'Volume name must be lowercase letters, digits and "-" (at most 63 characters), starting and ending with a letter or digit.';
  }
  if (!mountPath) return 'Mount path is required.';
  if (!ABSOLUTE_PATH.test(mountPath)) return 'Mount path must be an absolute path (start with "/") with no spaces.';
  if (!hostPath) return 'Host path is required.';
  if (!ABSOLUTE_PATH.test(hostPath)) return 'Host path must be an absolute path (start with "/") with no spaces.';
  return null;
}

/**
 * Validate an untrusted `storage` value (from a request body or app-config.json).
 * Returns the normalized storage (only the known keys, trimmed) or an error.
 */
export function validateDeploymentStorage(
  value: unknown
): { valid: true; storage: DeploymentStorage } | { valid: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: 'storage must be an object with a hostPath list.' };
  }
  const hostPath = (value as { hostPath?: unknown }).hostPath;
  if (!Array.isArray(hostPath) || hostPath.length === 0) {
    return { valid: false, error: 'storage.hostPath must contain at least one mount.' };
  }

  const mounts: HostPathMount[] = [];
  const seenNames = new Set<string>();
  for (const entry of hostPath) {
    if (!entry || typeof entry !== 'object') {
      return { valid: false, error: 'Each storage.hostPath entry must be an object.' };
    }
    const raw = entry as Record<string, unknown>;
    const mount: HostPathMount = {
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      mountPath: typeof raw.mountPath === 'string' ? raw.mountPath.trim() : '',
      path: typeof raw.path === 'string' ? raw.path.trim() : '',
    };
    const error = validateHostPathMount(mount);
    if (error) return { valid: false, error };
    if (seenNames.has(mount.name)) {
      return { valid: false, error: `Duplicate volume name "${mount.name}".` };
    }
    seenNames.add(mount.name);
    mounts.push(mount);
  }
  return { valid: true, storage: { hostPath: mounts } };
}

/**
 * The storage configured for an environment entry, or `null` when it has none
 * or what is there is invalid (an invalid block is never emitted).
 */
export function readEnvironmentStorage(entry: { storage?: unknown } | undefined | null): DeploymentStorage | null {
  if (!entry || entry.storage === undefined || entry.storage === null) return null;
  const result = validateDeploymentStorage(entry.storage);
  return result.valid ? result.storage : null;
}

/**
 * The `spec.storage` block currently in a deployment YAML string, as written
 * (not validated — the user may have hand-edited it), or `null` when there is
 * none or the YAML does not parse.
 */
export function getDeploymentStorage(yamlStr: string): DeploymentStorage | null {
  if (!yamlStr.trim()) return null;
  try {
    const doc = yaml.load(yamlStr) as { spec?: { storage?: unknown } } | null;
    const storage = doc && typeof doc === 'object' ? doc.spec?.storage : undefined;
    return storage && typeof storage === 'object' ? (storage as DeploymentStorage) : null;
  } catch {
    return null;
  }
}

/**
 * Add (`storage` set) or remove (`storage` null) `spec.storage` in a deployment
 * YAML string, preserving the user's other edits. The block is written last in
 * `spec` (after `engineConfig`), matching the operator examples. Unparseable
 * YAML is returned unchanged.
 */
export function applyDeploymentStorage(yamlStr: string, storage: DeploymentStorage | null): string {
  if (!yamlStr.trim()) return yamlStr;
  try {
    const doc = yaml.load(yamlStr) as { spec?: Record<string, unknown> } | null;
    if (!doc || typeof doc !== 'object') return yamlStr;
    const spec = { ...(doc.spec || {}) };
    delete spec.storage;
    doc.spec = storage ? { ...spec, storage } : spec;
    return yaml.dump(doc, DUMP_OPTIONS).trimEnd();
  } catch {
    return yamlStr;
  }
}

/** The `storage:` snippet as it will appear in the deployment YAML (for previews). */
export function formatStorageYaml(storage: DeploymentStorage): string {
  return yaml.dump({ storage }, DUMP_OPTIONS).trimEnd();
}

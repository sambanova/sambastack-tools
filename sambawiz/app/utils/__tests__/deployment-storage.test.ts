import yaml from 'js-yaml';
import {
  applyDeploymentStorage,
  formatStorageYaml,
  getDeploymentStorage,
  readEnvironmentStorage,
  validateDeploymentStorage,
  validateHostPathMount,
  type DeploymentStorage,
} from '../deployment-storage';

/**
 * Tests for the air-gapped `spec.storage` helpers (CUSTEI-1560): validation of
 * the app-config.json block, and adding/removing it in deployment YAML.
 */

const storage: DeploymentStorage = {
  hostPath: [{ name: 'nfs', mountPath: '/nfsdata', path: '/data/sambastack-ml-data' }],
};

const baseYaml = [
  'apiVersion: sambanova.ai/v1alpha1',
  'kind: ModelDeployment',
  'metadata:',
  '  name: md-gpt-oss-120b',
  'spec:',
  '  bundle: gpt-oss-120b',
  '  owner: no-reply@sambanova.ai',
  '  secretNames:',
  '    - sambanova-artifact-reader',
  '  engineConfig:',
  '    startupTimeout: 7200',
].join('\n');

describe('validateHostPathMount', () => {
  it('accepts the ticket example', () => {
    expect(validateHostPathMount(storage.hostPath[0])).toBeNull();
  });

  it.each([
    [{ name: '', mountPath: '/nfsdata', path: '/data' }, /Volume name is required/],
    [{ name: 'NFS', mountPath: '/nfsdata', path: '/data' }, /Volume name must be lowercase/],
    [{ name: 'nfs_data', mountPath: '/nfsdata', path: '/data' }, /Volume name must be lowercase/],
    [{ name: 'a'.repeat(64), mountPath: '/nfsdata', path: '/data' }, /at most 63/],
    [{ name: 'nfs', mountPath: '', path: '/data' }, /Mount path is required/],
    [{ name: 'nfs', mountPath: 'nfsdata', path: '/data' }, /Mount path must be an absolute path/],
    [{ name: 'nfs', mountPath: '/nfsdata', path: '' }, /Host path is required/],
    [{ name: 'nfs', mountPath: '/nfsdata', path: '/my data' }, /Host path must be an absolute path/],
  ])('rejects %j', (mount, message) => {
    expect(validateHostPathMount(mount)).toMatch(message);
  });
});

describe('validateDeploymentStorage', () => {
  it('normalizes a valid block (trims, drops unknown keys)', () => {
    const result = validateDeploymentStorage({
      hostPath: [{ name: ' nfs ', mountPath: '/nfsdata', path: '/data/sambastack-ml-data', extra: 1 }],
    });
    expect(result).toEqual({ valid: true, storage });
  });

  it.each([null, 'x', [], {}, { hostPath: [] }, { hostPath: 'nfs' }, { hostPath: [null] }])(
    'rejects %j',
    (value) => {
      expect(validateDeploymentStorage(value).valid).toBe(false);
    }
  );

  it('rejects duplicate volume names', () => {
    const result = validateDeploymentStorage({
      hostPath: [storage.hostPath[0], { ...storage.hostPath[0], mountPath: '/other' }],
    });
    expect(result).toEqual({ valid: false, error: 'Duplicate volume name "nfs".' });
  });
});

describe('readEnvironmentStorage', () => {
  it('returns null for environments without storage (online installs)', () => {
    expect(readEnvironmentStorage(undefined)).toBeNull();
    expect(readEnvironmentStorage({})).toBeNull();
    expect(readEnvironmentStorage({ storage: null })).toBeNull();
  });

  it('returns null for an invalid block so it is never emitted', () => {
    expect(readEnvironmentStorage({ storage: { hostPath: [{ name: 'nfs' }] } })).toBeNull();
  });

  it('returns the configured storage', () => {
    expect(readEnvironmentStorage({ storage })).toEqual(storage);
  });
});

describe('applyDeploymentStorage / getDeploymentStorage', () => {
  it('appends spec.storage after engineConfig, matching the expected YAML', () => {
    const out = applyDeploymentStorage(baseYaml, storage);
    const doc = yaml.load(out) as { spec: Record<string, unknown> };
    expect(Object.keys(doc.spec)).toEqual(['bundle', 'owner', 'secretNames', 'engineConfig', 'storage']);
    expect(doc.spec.storage).toEqual(storage);
    // secretNames stays alongside storage (confirmed working on air-gapped clusters).
    expect(doc.spec.secretNames).toEqual(['sambanova-artifact-reader']);
    expect(getDeploymentStorage(out)).toEqual(storage);
  });

  it('replaces an existing block rather than duplicating it', () => {
    const other: DeploymentStorage = {
      hostPath: [{ name: 'local', mountPath: '/nfsdata', path: '/mnt/ckpts' }],
    };
    const out = applyDeploymentStorage(applyDeploymentStorage(baseYaml, storage), other);
    expect(getDeploymentStorage(out)).toEqual(other);
    expect(out.match(/storage:/g)).toHaveLength(1);
  });

  it('removes the block and keeps everything else', () => {
    const out = applyDeploymentStorage(applyDeploymentStorage(baseYaml, storage), null);
    expect(getDeploymentStorage(out)).toBeNull();
    expect(out).not.toContain('storage:');
    expect(yaml.load(out)).toEqual(yaml.load(baseYaml));
  });

  it('leaves empty or unparseable YAML untouched', () => {
    expect(applyDeploymentStorage('', storage)).toBe('');
    const broken = 'spec: [unclosed';
    expect(applyDeploymentStorage(broken, storage)).toBe(broken);
    expect(getDeploymentStorage(broken)).toBeNull();
    expect(getDeploymentStorage(baseYaml)).toBeNull();
  });
});

describe('formatStorageYaml', () => {
  it('renders the snippet shown in the settings preview', () => {
    expect(formatStorageYaml(storage)).toBe(
      [
        'storage:',
        '  hostPath:',
        '    - name: nfs',
        '      mountPath: /nfsdata',
        '      path: /data/sambastack-ml-data',
      ].join('\n')
    );
  });
});

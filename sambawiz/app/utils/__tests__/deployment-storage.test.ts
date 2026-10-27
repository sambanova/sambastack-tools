import yaml from 'js-yaml';
import {
  applyDeploymentStorage,
  deploymentStorageProblem,
  PLACEHOLDER_STORAGE,
  formatStorageYaml,
  getDeploymentStorage,
  readEnvironmentStorage,
  environmentStorageError,
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

describe('environmentStorageError', () => {
  it('is null when there is no storage or it is valid', () => {
    expect(environmentStorageError(undefined)).toBeNull();
    expect(environmentStorageError({})).toBeNull();
    expect(environmentStorageError({ storage: null })).toBeNull();
    expect(environmentStorageError({ storage })).toBeNull();
  });

  it('explains an invalid block instead of letting it be silently dropped', () => {
    expect(environmentStorageError({ storage: { hostPath: [{ name: 'nfs', path: '/data' }] } })).toMatch(/Mount path is required/);
    // A volume type other than hostPath (e.g. a direct NFS mount) is not supported.
    expect(environmentStorageError({ storage: { nfs: { server: 'nfs.local', path: '/export' } } })).toMatch(/hostPath/);
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

describe('deploymentStorageProblem', () => {
  it('is null without a storage block, or with a valid one', () => {
    expect(deploymentStorageProblem(baseYaml)).toBeNull();
    expect(deploymentStorageProblem(applyDeploymentStorage(baseYaml, storage))).toBeNull();
    expect(deploymentStorageProblem('')).toBeNull();
  });

  it('names the placeholders still left in the block', () => {
    expect(deploymentStorageProblem(applyDeploymentStorage(baseYaml, PLACEHOLDER_STORAGE))).toBe(
      'Replace the placeholder `mountPath` and `path` in spec.storage with your cluster\'s paths.'
    );
    const halfDone = { hostPath: [{ ...PLACEHOLDER_STORAGE.hostPath[0], mountPath: '/nfsdata' }] };
    expect(deploymentStorageProblem(applyDeploymentStorage(baseYaml, halfDone))).toBe(
      'Replace the placeholder `path` in spec.storage with your cluster\'s paths.'
    );
  });

  it('reports a hand-edited block that is invalid', () => {
    const relative = { hostPath: [{ name: 'nfs', mountPath: '/nfsdata', path: 'data/ckpts' }] };
    expect(deploymentStorageProblem(applyDeploymentStorage(baseYaml, relative))).toBe(
      'Host path must be an absolute path (start with "/") with no spaces.'
    );
  });
});

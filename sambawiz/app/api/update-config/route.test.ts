/**
 * @jest-environment node
 */
import { POST } from './route';
import fs from 'fs';

// Mock fs (route uses the synchronous API)
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

// PEF refresh is covered by pef-config-generator.test.ts; mocked here so this
// suite stays focused on what update-config writes.
jest.mock('../../utils/pef-config-generator', () => ({
  generatePefConfigs: jest.fn().mockResolvedValue({ success: true, count: 0 }),
}));

const storage = {
  hostPath: [{ name: 'nfs', mountPath: '/nfsdata', path: '/data/sambastack-ml-data' }],
};

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/update-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The app-config.json content from the last write. */
function lastWrittenConfig() {
  const calls = (fs.writeFileSync as jest.Mock).mock.calls;
  return JSON.parse(calls[calls.length - 1][1]);
}

describe('update-config route — air-gapped storage', () => {
  const baseConfig = (devEntry: Record<string, unknown> = {}) => ({
    currentKubeconfig: 'dev',
    kubeconfigs: {
      dev: { file: 'kubeconfigs/dev.yaml', namespace: 'default', ...devEntry },
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
  });

  it('saves a valid storage block on the environment', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(baseConfig()));

    const response = await POST(makeRequest({ environment: 'dev', namespace: 'default', storage }));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(lastWrittenConfig().kubeconfigs.dev.storage).toEqual(storage);
  });

  it('removes the storage block when storage is null', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(baseConfig({ storage })));

    const response = await POST(makeRequest({ environment: 'dev', namespace: 'default', storage: null }));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(lastWrittenConfig().kubeconfigs.dev).not.toHaveProperty('storage');
  });

  it('leaves the saved storage untouched when storage is omitted', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(baseConfig({ storage })));

    const response = await POST(makeRequest({ environment: 'dev', namespace: 'default' }));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(lastWrittenConfig().kubeconfigs.dev.storage).toEqual(storage);
  });

  it('rejects an invalid storage block with 400 before writing anything', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(baseConfig()));

    const response = await POST(
      makeRequest({
        environment: 'dev',
        namespace: 'default',
        storage: { hostPath: [{ name: 'nfs', mountPath: '/nfsdata', path: 'relative/path' }] },
      })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/Host path must be an absolute path/);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

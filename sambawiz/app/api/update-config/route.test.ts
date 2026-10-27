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

// Air-gapped storage is saved by /api/deployment-storage-state; saving the
// environment settings here must keep it.
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

  it('keeps the environment\'s saved storage', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(baseConfig({ storage })));

    const response = await POST(makeRequest({ environment: 'dev', namespace: 'default' }));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(lastWrittenConfig().kubeconfigs.dev.storage).toEqual(storage);
  });
});

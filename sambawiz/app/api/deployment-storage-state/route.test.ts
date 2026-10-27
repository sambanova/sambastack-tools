/**
 * @jest-environment node
 */
import { GET, POST } from './route';
import fs from 'fs';
import type { NextRequest } from 'next/server';

// Mock fs (route uses the synchronous API)
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

const storage = {
  hostPath: [{ name: 'nfs', mountPath: '/nfsdata', path: '/data/sambastack-ml-data' }],
};

const appConfig = JSON.stringify({
  currentKubeconfig: 'dev',
  kubeconfigs: { dev: { file: 'kubeconfigs/dev.yaml', namespace: 'default' }, prod: { file: 'kubeconfigs/prod.yaml' } },
});

/** Serve app-config.json and the state file from these contents. */
function mockFiles(state: unknown) {
  (fs.readFileSync as jest.Mock).mockImplementation((file: string) =>
    String(file).endsWith('app-config.json') ? appConfig : JSON.stringify(state)
  );
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/deployment-storage-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** The state file content from the last write. */
function lastWrittenState() {
  const calls = (fs.writeFileSync as jest.Mock).mock.calls;
  return JSON.parse(calls[calls.length - 1][1]);
}

describe('deployment-storage-state route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
  });

  it('returns only the current environment\'s remembered blocks', async () => {
    mockFiles({ dev: { 'bundle:b1': storage }, prod: { 'bundle:b2': storage } });
    const data = await (await GET()).json();
    expect(data).toEqual({ success: true, storage: { 'bundle:b1': storage } });
  });

  it('saves a block for a bundle without touching other environments', async () => {
    mockFiles({ prod: { 'bundle:b2': storage } });
    const response = await POST(makeRequest({ key: 'bundle:b1', storage }));
    expect(response.status).toBe(200);
    expect(lastWrittenState()).toEqual({ dev: { 'bundle:b1': storage }, prod: { 'bundle:b2': storage } });
  });

  it('forgets a block when storage is null', async () => {
    mockFiles({ dev: { 'bundle:b1': storage, 'model:m1:arch:1': storage } });
    await POST(makeRequest({ key: 'bundle:b1', storage: null }));
    expect(lastWrittenState()).toEqual({ dev: { 'model:m1:arch:1': storage } });
  });

  it('rejects an invalid block or key with 400 before writing anything', async () => {
    mockFiles({});
    const placeholder = { hostPath: [{ name: 'nfs', mountPath: 'CHANGE_ME_MOUNT_PATH_IN_POD', path: '/data' }] };
    expect((await POST(makeRequest({ key: 'bundle:b1', storage: placeholder }))).status).toBe(400);
    expect((await POST(makeRequest({ key: 'b1', storage }))).status).toBe(400);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

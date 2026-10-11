import path from 'path';
import { readFileSync } from 'fs';
import { resolveArtifactsDir, resolveArtifactPath } from '../artifacts-dir';

jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
}));

const mockReadFileSync = readFileSync as jest.Mock;

function withConfig(config: unknown) {
  mockReadFileSync.mockReturnValue(JSON.stringify(config));
}

describe('resolveArtifactsDir', () => {
  beforeEach(() => mockReadFileSync.mockReset());

  it('defaults to saved_artifacts under the SambaWiz directory', () => {
    withConfig({});
    expect(resolveArtifactsDir()).toBe(path.join(process.cwd(), 'saved_artifacts'));
  });

  it('defaults when app-config.json cannot be read', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(resolveArtifactsDir()).toBe(path.join(process.cwd(), 'saved_artifacts'));
  });

  it('resolves a relative artifactsDir against the SambaWiz directory', () => {
    withConfig({ artifactsDir: 'work/bundles' });
    expect(resolveArtifactsDir()).toBe(path.join(process.cwd(), 'work/bundles'));
  });

  it('uses an absolute artifactsDir as given', () => {
    withConfig({ artifactsDir: '/home/snadm/bundles' });
    expect(resolveArtifactsDir()).toBe('/home/snadm/bundles');
  });

  it('ignores an empty or blank artifactsDir', () => {
    withConfig({ artifactsDir: '   ' });
    expect(resolveArtifactsDir()).toBe(path.join(process.cwd(), 'saved_artifacts'));
  });
});

describe('resolveArtifactPath', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    withConfig({ artifactsDir: '/home/snadm/bundles' });
  });

  it('resolves a plain file name inside the directory', () => {
    expect(resolveArtifactPath('llama-gpt-emb.yaml')).toBe('/home/snadm/bundles/llama-gpt-emb.yaml');
  });

  it('rejects a name that climbs out of the directory', () => {
    expect(resolveArtifactPath('../../etc/passwd')).toBeNull();
  });

  it('rejects an absolute name', () => {
    expect(resolveArtifactPath('/etc/passwd')).toBeNull();
  });

  it('rejects a sibling directory that shares the prefix', () => {
    expect(resolveArtifactPath('../bundles-other/x.yaml')).toBeNull();
  });
});

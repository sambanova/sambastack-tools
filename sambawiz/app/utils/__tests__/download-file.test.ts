import { toYamlFileName, downloadTextFile } from '../download-file';

describe('toYamlFileName', () => {
  it('appends the extension to a plain name', () => {
    expect(toYamlFileName('llama-gpt-emb')).toBe('llama-gpt-emb.yaml');
  });

  it('keeps an extension the name already has', () => {
    expect(toYamlFileName('bundle.yaml')).toBe('bundle.yaml');
    expect(toYamlFileName('bundle.yml')).toBe('bundle.yml');
  });

  it('replaces characters a filesystem treats specially', () => {
    expect(toYamlFileName('my bundle/v2')).toBe('my-bundle-v2.yaml');
  });

  it('falls back when the name has nothing usable', () => {
    expect(toYamlFileName('   ')).toBe('bundle.yaml');
    expect(toYamlFileName('///', 'deployment')).toBe('deployment.yaml');
  });
});

describe('downloadTextFile', () => {
  const createObjectURL = jest.fn(() => 'blob:test');
  const revokeObjectURL = jest.fn();

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true });
  });

  it('clicks an anchor with the download name and cleans up after itself', () => {
    const click = jest.fn();
    const created: HTMLAnchorElement[] = [];
    const realCreateElement = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag) as HTMLAnchorElement;
      if (tag === 'a') {
        el.click = click;
        created.push(el);
      }
      return el;
    });

    downloadTextFile('llama-gpt-emb.yaml', 'kind: ModelBundle\n');

    expect(created).toHaveLength(1);
    expect(created[0].download).toBe('llama-gpt-emb.yaml');
    expect(created[0].href).toContain('blob:test');
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(document.querySelector('a')).toBeNull();

    (document.createElement as jest.Mock).mockRestore();
  });
});

import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import Home from '../../components/Home';
import { mockEnvironments } from './mock-data';

// Mock fetch globally
global.fetch = jest.fn();

describe('Home Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  it('should load environments on mount', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockEnvironments,
    });

    renderWithProviders(<Home />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/environments');
    });
  });

  describe('air-gapped storage settings (CUSTEI-1560)', () => {
    const storage = {
      hostPath: [{ name: 'nfs', mountPath: '/nfsdata', path: '/data/sambastack-ml-data' }],
    };

    // `/api/environments` returns one env (with or without storage); everything
    // after update-config fails fast so the test never reaches the page reload.
    const mockFetch = (envStorage?: unknown) => {
      (global.fetch as jest.Mock).mockImplementation((url: string) => {
        if (url === '/api/environments') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              environments: ['agstack2'],
              defaultEnvironment: 'agstack2',
              defaultNamespace: 'default',
              kubeconfigs: {
                agstack2: { file: 'kubeconfigs/agstack2.yaml', namespace: 'default', ...(envStorage ? { storage: envStorage } : {}) },
              },
            }),
          });
        }
        if (url === '/api/update-config') {
          return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ success: false }) });
      });
    };

    const updateConfigBody = () => {
      const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === '/api/update-config');
      return call ? JSON.parse(call[1].body) : undefined;
    };

    const storageSwitch = () =>
      screen.findByRole('switch', { name: /Air-gapped environment/ });

    it('pre-fills the form from app-config.json and saves the storage block', async () => {
      mockFetch(storage);
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<Home />);
      });

      expect(await storageSwitch()).toBeChecked();
      await waitFor(() =>
        expect(screen.getByLabelText(/Host path on node/)).toHaveValue('/data/sambastack-ml-data')
      );
      expect(screen.getByTestId('home-storage-preview')).toHaveTextContent('mountPath: /nfsdata');

      await user.click(screen.getByRole('button', { name: 'Apply Configuration' }));
      await waitFor(() => expect(updateConfigBody()).toBeDefined());
      expect(updateConfigBody().storage).toEqual(storage);
    });

    it('defaults only the volume name: both paths start empty and are required', async () => {
      mockFetch(undefined);
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<Home />);
      });

      const toggle = await storageSwitch();
      expect(toggle).not.toBeChecked();
      await user.click(toggle);

      expect(screen.getByLabelText('Volume name')).toHaveValue('nfs');
      // The mount path has to match the install's local:// substitution target, so it is never guessed.
      expect(screen.getByLabelText(/Mount path in pod/)).toHaveValue('');
      expect(screen.getByLabelText(/Host path on node/)).toHaveValue('');
      expect(screen.getAllByText('Mount path is required.').length).toBeGreaterThan(0);

      await user.click(screen.getByRole('button', { name: 'Apply Configuration' }));
      expect(await screen.findByText('Air-gapped storage: Mount path is required.')).toBeInTheDocument();
      expect(updateConfigBody()).toBeUndefined();

      await user.type(screen.getByLabelText(/Mount path in pod/), '/mnt/models');
      await user.click(screen.getByRole('button', { name: 'Apply Configuration' }));
      expect(await screen.findByText('Air-gapped storage: Host path is required.')).toBeInTheDocument();
      expect(updateConfigBody()).toBeUndefined();

      await user.type(screen.getByLabelText(/Host path on node/), '/mnt/ckpts');
      await user.click(screen.getByRole('button', { name: 'Apply Configuration' }));
      await waitFor(() => expect(updateConfigBody()).toBeDefined());
      expect(updateConfigBody().storage).toEqual({
        hostPath: [{ name: 'nfs', mountPath: '/mnt/models', path: '/mnt/ckpts' }],
      });
    });

    it('shows an invalid saved block (instead of hiding it) so it can be fixed', async () => {
      mockFetch({ hostPath: [{ name: 'nfs', path: '/data/ckpts' }] });
      await act(async () => {
        renderWithProviders(<Home />);
      });

      expect(await storageSwitch()).toBeChecked();
      expect(await screen.findByText(/saved in app-config.json for this environment is invalid/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Host path on node/)).toHaveValue('/data/ckpts');
      expect(screen.getByLabelText(/Mount path in pod/)).toHaveValue('');
    });

    it('sends storage: null (removing it) when the switch is turned off', async () => {
      mockFetch(storage);
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<Home />);
      });

      const toggle = await storageSwitch();
      await waitFor(() => expect(toggle).toBeChecked());
      await user.click(toggle);

      await user.click(screen.getByRole('button', { name: 'Apply Configuration' }));
      await waitFor(() => expect(updateConfigBody()).toBeDefined());
      expect(updateConfigBody().storage).toBeNull();
    });
  });
});

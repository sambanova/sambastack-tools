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

  it('points air-gapped users to the deployment page and never sends storage from Apply', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
      if (url === '/api/environments') {
        return ok({
          success: true,
          environments: ['agstack2'],
          defaultEnvironment: 'agstack2',
          defaultNamespace: 'default',
          kubeconfigs: { agstack2: { file: 'kubeconfigs/agstack2.yaml', namespace: 'default' } },
        });
      }
      if (url === '/api/update-config') return ok({ success: true });
      return ok({ success: false });
    });
    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<Home />);
    });

    expect(await screen.findByText(/Air-gapped environment\?/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Air-gapped/ })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply Configuration' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Apply Configuration' }));
    const call = await waitFor(() => {
      const c = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === '/api/update-config');
      expect(c).toBeDefined();
      return c;
    });
    // Omitted (not null), so a storage block hand-written in app-config.json for the CLI is left alone.
    expect(JSON.parse(call[1].body)).not.toHaveProperty('storage');
  });

  it('keeps the success message up after Apply and refreshes the navbar in place', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
      switch (url) {
        case '/api/environments':
          return ok({
            success: true,
            environments: ['agstack2'],
            defaultEnvironment: 'agstack2',
            defaultNamespace: 'default',
            kubeconfigs: { agstack2: { file: 'kubeconfigs/agstack2.yaml', namespace: 'default' } },
          });
        case '/api/update-config':
          return ok({ success: true });
        case '/api/generate-checkpoint-mapping':
          return ok({ success: true, count: 12 });
        case '/api/generate-model-profiles':
          return ok({ success: true, count: 30 });
        default:
          return ok({ success: false });
      }
    });
    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<Home />);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply Configuration' })).toBeEnabled());
    const validateCalls = () =>
      (global.fetch as jest.Mock).mock.calls.filter(([url]) => url === '/api/kubeconfig-validate').length;
    const before = validateCalls();

    await user.click(screen.getByRole('button', { name: 'Apply Configuration' }));

    expect(
      await screen.findByText('Environment "agstack2" applied: 12 models and 30 model profiles loaded from the cluster.')
    ).toBeInTheDocument();
    expect(validateCalls()).toBe(before + 1);
  });
});

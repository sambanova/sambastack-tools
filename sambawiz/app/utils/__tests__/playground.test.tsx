import { waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import Playground from '../../components/Playground';
import { mockEnvironments } from './mock-data';

// Mock fetch globally
global.fetch = jest.fn();

describe('Playground Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  it('should fetch deployments and environments on mount', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, bundleDeployments: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEnvironments,
      });

    renderWithProviders(<Playground />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/bundle-deployment');
      expect(global.fetch).toHaveBeenCalledWith('/api/environments');
    });
  });
});

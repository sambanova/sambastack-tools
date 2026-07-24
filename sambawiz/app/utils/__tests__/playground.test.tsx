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

  it('should fetch models, environments, and checkpoint mapping on mount', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, models: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEnvironments,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });

    renderWithProviders(<Playground />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/models');
      expect(global.fetch).toHaveBeenCalledWith('/api/environments');
      expect(global.fetch).toHaveBeenCalledWith('/api/checkpoint-mapping');
    });
  });
});

import { waitFor } from '@testing-library/react';
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
});

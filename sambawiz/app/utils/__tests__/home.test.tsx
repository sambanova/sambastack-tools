import React from 'react';
import { screen, waitFor } from '@testing-library/react';
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

  describe('Initial Load', () => {
    it('should render the home page with all main elements', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEnvironments,
      });

      renderWithProviders(<Home />);

      await waitFor(() => {
        expect(screen.getByText(/SambaWiz/i)).toBeInTheDocument();
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

  describe('Namespace Input', () => {
    it('should render namespace input field', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEnvironments,
      });

      renderWithProviders(<Home />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Namespace/i)).toBeInTheDocument();
      });
    });

    it('should allow editing namespace', async () => {
      const user = userEvent.setup();
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEnvironments,
      });

      renderWithProviders(<Home />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Namespace/i)).toBeInTheDocument();
      });

      const namespaceInput = screen.getByLabelText(/Namespace/i);
      await user.clear(namespaceInput);
      await user.type(namespaceInput, 'custom-namespace');

      expect((namespaceInput as HTMLInputElement).value).toBe('custom-namespace');
    });
  });

});

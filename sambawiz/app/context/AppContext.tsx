'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface KubeconfigValidationState {
  envVersion: string | null;
  fullVersion: string | null;
  envName: string | null;
  namespace: string | null;
  validationError: string | null;
  helmCommand: string;
  errorDetails: string;
  helmVersionError: boolean;
  hasNonNumericalSuffix: boolean;
  minimumVersion: string | null;
  isLoading: boolean;
  refetch: () => void;
}

const AppContext = createContext<KubeconfigValidationState | null>(null);

export function AppContextProvider({ children }: { children: React.ReactNode }) {
  const [envVersion, setEnvVersion] = useState<string | null>(null);
  const [fullVersion, setFullVersion] = useState<string | null>(null);
  const [envName, setEnvName] = useState<string | null>(null);
  const [namespace, setNamespace] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [helmCommand, setHelmCommand] = useState<string>('');
  const [errorDetails, setErrorDetails] = useState<string>('');
  const [helmVersionError, setHelmVersionError] = useState<boolean>(false);
  const [hasNonNumericalSuffix, setHasNonNumericalSuffix] = useState<boolean>(false);
  const [minimumVersion, setMinimumVersion] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchValidation = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/kubeconfig-validate');
      const data = await response.json();

      console.log('Kubeconfig validation response:', data);

      if (data.success) {
        setEnvVersion(data.version);
        setFullVersion(data.fullVersion || null);
        setEnvName(data.envName);
        setNamespace(data.namespace);
        setHasNonNumericalSuffix(data.hasNonNumericalSuffix || false);
        setValidationError(null);
        setHelmCommand('');
        setErrorDetails('');
        setHelmVersionError(false);
        setMinimumVersion(null);
      } else {
        setValidationError(data.error || 'Failed to validate kubeconfig');
        setHelmCommand(data.helmCommand || '');
        setErrorDetails(data.errorDetails || data.error || '');
        setHelmVersionError(data.helmVersionError || false);
        setEnvVersion(null);
        setFullVersion(data.helmVersionError && data.version ? data.version : null);
        setEnvName(null);
        setNamespace(null);
        setHasNonNumericalSuffix(false);
        setMinimumVersion(data.minimumVersion || null);
      }
    } catch (error) {
      console.error('Failed to validate kubeconfig:', error);
      setValidationError('Failed to validate kubeconfig');
      setHelmCommand('');
      setErrorDetails('Network error or server unreachable');
      setHelmVersionError(false);
      setEnvVersion(null);
      setFullVersion(null);
      setEnvName(null);
      setNamespace(null);
      setHasNonNumericalSuffix(false);
      setMinimumVersion(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchValidation();
  }, [fetchValidation]);

  return (
    <AppContext.Provider
      value={{
        envVersion,
        fullVersion,
        envName,
        namespace,
        validationError,
        helmCommand,
        errorDetails,
        helmVersionError,
        hasNonNumericalSuffix,
        minimumVersion,
        isLoading,
        refetch: fetchValidation,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): KubeconfigValidationState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppContextProvider');
  return ctx;
}

'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface AppContextType {
  envVersion: string | null;
  envName: string | null;
  namespace: string | null;
  validationError: string | null;
  showErrorDialog: boolean;
  helmCommand: string;
  errorDetails: string;
  helmVersionError: boolean;
  hasNonNumericalSuffix: boolean;
  appVersion: string | null;
  setShowErrorDialog: (value: boolean) => void;
  refetch: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [envVersion, setEnvVersion] = useState<string | null>(null);
  const [envName, setEnvName] = useState<string | null>(null);
  const [namespace, setNamespace] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showErrorDialog, setShowErrorDialog] = useState<boolean>(false);
  const [helmCommand, setHelmCommand] = useState<string>('');
  const [errorDetails, setErrorDetails] = useState<string>('');
  const [helmVersionError, setHelmVersionError] = useState<boolean>(false);
  const [hasNonNumericalSuffix, setHasNonNumericalSuffix] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    // Validate kubeconfig
    try {
      const response = await fetch('/api/kubeconfig-validate');
      const data = await response.json();

      console.log('Kubeconfig validation response:', data);

      if (data.success) {
        setEnvVersion(data.version);
        setEnvName(data.envName);
        setNamespace(data.namespace);
        setHasNonNumericalSuffix(data.hasNonNumericalSuffix || false);
        setValidationError(null);
        setShowErrorDialog(false);
        setHelmVersionError(false);
      } else {
        console.log('Validation failed, showing error dialog');
        setValidationError(data.error || 'Failed to validate kubeconfig');
        setHelmCommand(data.helmCommand || '');
        setErrorDetails(data.errorDetails || data.error || '');
        setShowErrorDialog(true);
        setEnvVersion(null);
        setEnvName(null);
        setNamespace(null);
        setHasNonNumericalSuffix(false);
        setHelmVersionError(data.helmVersionError || false);
      }
    } catch (error) {
      console.error('Failed to validate kubeconfig:', error);
      setValidationError('Failed to validate kubeconfig');
      setHelmCommand('');
      setErrorDetails('Network error or server unreachable');
      setShowErrorDialog(true);
      setEnvVersion(null);
      setEnvName(null);
      setNamespace(null);
      setHasNonNumericalSuffix(false);
      setHelmVersionError(false);
    }

    // Fetch app version
    try {
      const response = await fetch('/api/app-version');
      const data = await response.json();

      if (data.success) {
        setAppVersion(data.version);
      }
    } catch (error) {
      console.error('Failed to fetch app version:', error);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return (
    <AppContext.Provider
      value={{
        envVersion,
        envName,
        namespace,
        validationError,
        showErrorDialog,
        helmCommand,
        errorDetails,
        helmVersionError,
        hasNonNumericalSuffix,
        appVersion,
        setShowErrorDialog,
        refetch: fetchAll,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used inside AppProvider');
  return ctx;
}

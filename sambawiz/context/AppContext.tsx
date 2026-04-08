'use client';

import { createContext, useContext, useState, useCallback } from 'react';
import useSWR from 'swr';

interface AppContextType {
  envVersion: string | null;
  envName: string | null;
  namespace: string | null;
  fullHelmVersion: string | null;
  minimumHelmVersion: string | null;
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

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [showErrorDialog, setShowErrorDialog] = useState<boolean>(false);

  const { data: helmData, mutate: mutateHelm } = useSWR(
    '/api/kubeconfig-validate',
    fetcher,
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );

  const { data: versionData } = useSWR(
    '/api/app-version',
    fetcher,
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );

  // Derived values from SWR data
  const success = helmData?.success;
  const envVersion = success ? helmData.version : null;
  const envName = success ? helmData.envName : null;
  const namespace = success ? helmData.namespace : null;
  const hasNonNumericalSuffix = success ? (helmData.hasNonNumericalSuffix || false) : false;
  const validationError = helmData && !success ? (helmData.error || 'Failed to validate kubeconfig') : null;
  const helmCommand = helmData && !success ? (helmData.helmCommand || '') : '';
  const errorDetails = helmData && !success ? (helmData.errorDetails || helmData.error || '') : '';
  const helmVersionError = helmData && !success ? (helmData.helmVersionError || false) : false;

  // Full version info exposed for Home.tsx
  const fullHelmVersion = helmData?.fullVersion || helmData?.version || null;
  const minimumHelmVersion = helmData?.minimumVersion || null;

  const appVersion = versionData?.success ? versionData.version : null;

  const refetch = useCallback(() => { mutateHelm(); }, [mutateHelm]);

  return (
    <AppContext.Provider
      value={{
        envVersion,
        envName,
        namespace,
        fullHelmVersion,
        minimumHelmVersion,
        validationError,
        showErrorDialog,
        helmCommand,
        errorDetails,
        helmVersionError,
        hasNonNumericalSuffix,
        appVersion,
        setShowErrorDialog,
        refetch,
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

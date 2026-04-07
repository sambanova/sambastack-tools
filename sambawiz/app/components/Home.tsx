'use client';

import { useState, useEffect, useCallback, useId, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { useAppContext } from '@/context/AppContext';
import { Eye, EyeOff, Copy, TriangleAlert, Loader2 } from 'lucide-react';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import AppConfigDialog from './AppConfigDialog';
import NoKubeconfigsDialog from './NoKubeconfigsDialog';
import DocumentationPanel from './DocumentationPanel';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  uiDomain?: string;
  apiDomain?: string;
  apiKey?: string;
  enableUpdates?: boolean;
}

function incrementVersion(version: string): string {
  const parts = version.split('.');
  const lastPart = parseInt(parts[parts.length - 1], 10);
  parts[parts.length - 1] = (lastPart + 1).toString();
  return parts.join('.');
}

function compareVersionStrings(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getNextVersion(currentVersion: string | null, minVersion: string | null): string {
  const fallback = '0.3.576';
  if (!currentVersion) return fallback;
  const versionMatch = currentVersion.match(/^(\d+\.\d+\.\d+)/);
  if (!versionMatch) return fallback;
  const incremented = incrementVersion(versionMatch[1]);
  if (minVersion && compareVersionStrings(minVersion, incremented) > 0) {
    return minVersion;
  }
  return incremented;
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());

// Tiny inner component so useSearchParams doesn't force the whole Home into Suspense
function SearchParamsWatcher({ onOpenUpgrade }: { onOpenUpgrade: () => void }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    if (searchParams.get('openUpgrade') === 'true') {
      router.replace('/');
      onOpenUpgrade();
    }
  }, [searchParams, router, onOpenUpgrade]);
  return null;
}

export default function Home() {
  const router = useRouter();
  const { fullHelmVersion, minimumHelmVersion, helmVersionError: helmVersionTooOld } = useAppContext();

  const namespaceId = useId();
  const apiDomainId = useId();
  const uiDomainId = useId();
  const apiKeyId = useId();
  const keycloakUsernameId = useId();
  const keycloakPasswordId = useId();
  const installYamlId = useId();

  const [selectedEnvironment, setSelectedEnvironment] = useState<string>('');
  const [namespace, setNamespace] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [apiDomain, setApiDomain] = useState<string>('');
  const [uiDomain, setUiDomain] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [kubeconfigs, setKubeconfigs] = useState<Record<string, KubeconfigEntry>>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [prerequisiteWarning, setPrerequisiteWarning] = useState<string | null>(null);
  const [showPrerequisiteDialog, setShowPrerequisiteDialog] = useState<boolean>(false);
  const [showAppConfigDialog, setShowAppConfigDialog] = useState<boolean>(false);
  const [showNoKubeconfigsDialog, setShowNoKubeconfigsDialog] = useState<boolean>(false);
  const [showApiKeyInstructionsDialog, setShowApiKeyInstructionsDialog] = useState<boolean>(false);
  const [keycloakUsername, setKeycloakUsername] = useState<string>('');
  const [keycloakPassword, setKeycloakPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loadingCredentials, setLoadingCredentials] = useState<boolean>(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [showInstallDialog, setShowInstallDialog] = useState<boolean>(false);
  const [installYaml, setInstallYaml] = useState<string>('');
  const [installing, setInstalling] = useState<boolean>(false);
  const [installOutput, setInstallOutput] = useState<string>('');
  const [installError, setInstallError] = useState<string | null>(null);
  const [installerLogs, setInstallerLogs] = useState<string>('');
  const [showInstallerLogs, setShowInstallerLogs] = useState<boolean>(false);
  const [enableUpdates, setEnableUpdates] = useState<boolean>(true);
  const [installationComplete, setInstallationComplete] = useState<boolean>(false);
  const [yamlModifiedAfterInstall, setYamlModifiedAfterInstall] = useState<boolean>(false);

  const envInitialized = useRef(false);

  // SWR: environments — cached, no re-fetch on tab switch
  const { data: envData } = useSWR('/api/environments', fetcher, {
    revalidateOnFocus: false,
  });

  // SWR: installer logs — conditional polling every 3s
  const { data: logsData } = useSWR(
    showInstallerLogs && !installationComplete ? '/api/installer-logs?lines=20' : null,
    fetcher,
    { refreshInterval: 3000, revalidateOnFocus: false }
  );

  // Initialize form state from SWR environments data (once on first load)
  useEffect(() => {
    if (!envData?.success || envInitialized.current) return;
    envInitialized.current = true;
    setEnvironments(envData.environments || []);
    setKubeconfigs(envData.kubeconfigs || {});
    if (envData.defaultEnvironment) setSelectedEnvironment(envData.defaultEnvironment);
    if (envData.defaultNamespace) setNamespace(envData.defaultNamespace);
    if (envData.defaultApiKey) setApiKey(envData.defaultApiKey);
    if (envData.defaultApiDomain) setApiDomain(envData.defaultApiDomain);
    if (envData.defaultUiDomain) setUiDomain(envData.defaultUiDomain);
    if (envData.defaultEnvironment && envData.kubeconfigs?.[envData.defaultEnvironment]) {
      const ev = envData.kubeconfigs[envData.defaultEnvironment].enableUpdates;
      setEnableUpdates(ev !== false);
    }
  }, [envData]);

  // Process installer logs from SWR polling
  useEffect(() => {
    if (!showInstallerLogs) {
      setInstallerLogs('');
      return;
    }
    if (!logsData) return;
    if (logsData.success) {
      setInstallerLogs(logsData.logs);
      const lines = (logsData.logs as string).trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (lastLine?.includes('configure_default_ingress')) {
        setInstallationComplete(true);
        setYamlModifiedAfterInstall(false);
      }
    } else {
      setInstallerLogs(`Error: ${logsData.error || 'Failed to fetch logs'}`);
    }
  }, [logsData, showInstallerLogs]);

  // Check prerequisites on mount (one-time setup check)
  useEffect(() => {
    const checkPrerequisites = async () => {
      try {
        const prereqResponse = await fetch('/api/check-prerequisites');
        const prereqData = await prereqResponse.json();

        if (prereqData.success) {
          const missing: string[] = [];
          if (!prereqData.prerequisites.kubectl) missing.push('kubectl');
          if (!prereqData.prerequisites.helm) missing.push('helm');
          if (missing.length > 0) {
            setPrerequisiteWarning(
              `The following required tools are not installed: ${missing.join(', ')}. Please install them on your system.`
            );
            setShowPrerequisiteDialog(true);
            return;
          }
        }

        const configResponse = await fetch('/api/check-app-config');
        const configData = await configResponse.json();

        if (configData.success && (!configData.exists || !configData.valid)) {
          setShowAppConfigDialog(true);
          return;
        }

        if (configData.success && configData.exists && configData.valid) {
          const config = configData.config;
          const kubeconfigsEmpty = Object.keys(config.kubeconfigs || {}).length === 0;
          const currentKubeconfigEmpty =
            !config.currentKubeconfig || config.currentKubeconfig.trim() === '';

          if (kubeconfigsEmpty && currentKubeconfigEmpty) {
            const kubeconfigFilesResponse = await fetch('/api/check-kubeconfig-files');
            const kubeconfigFilesData = await kubeconfigFilesResponse.json();

            if (kubeconfigFilesData.success && !kubeconfigFilesData.hasFiles) {
              setShowNoKubeconfigsDialog(true);
              return;
            }

            if (kubeconfigFilesData.success && kubeconfigFilesData.hasFiles) {
              try {
                const autoPopResponse = await fetch('/api/auto-populate-kubeconfigs', {
                  method: 'POST',
                });
                const autoPopData = await autoPopResponse.json();
                if (autoPopData.success) window.location.reload();
              } catch (error) {
                console.error('Failed to auto-populate kubeconfigs:', error);
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to check prerequisites:', error);
      }
    };

    checkPrerequisites();
  }, []);

  const handleEnvironmentChange = (envName: string | null) => {
    if (!envName) return;
    setSelectedEnvironment(envName);
    setSaveSuccess(false);
    setSaveError(null);

    if (envName && kubeconfigs[envName]) {
      setNamespace(kubeconfigs[envName].namespace || 'default');
      setApiKey(kubeconfigs[envName].apiKey || '');
      setApiDomain(kubeconfigs[envName].apiDomain || '');
      setUiDomain(kubeconfigs[envName].uiDomain || '');
      const ev = kubeconfigs[envName].enableUpdates;
      setEnableUpdates(ev !== false);
    } else {
      setNamespace('default');
      setApiKey('');
      setApiDomain('');
      setUiDomain('');
      setEnableUpdates(true);
    }
  };

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleApply = async () => {
    if (!selectedEnvironment || !namespace) {
      setSaveError('Please select an environment and enter a namespace');
      return;
    }

    if (apiDomain?.trim()) {
      if (!apiDomain.startsWith('https://')) {
        setSaveError('API Domain must start with https://');
        return;
      }
      if (apiDomain.includes(' ')) {
        setSaveError('API Domain cannot contain spaces');
        return;
      }
    }

    if (uiDomain?.trim()) {
      if (!uiDomain.startsWith('https://')) {
        setSaveError('UI Domain must start with https://');
        return;
      }
      if (uiDomain.includes(' ')) {
        setSaveError('UI Domain cannot contain spaces');
        return;
      }
    }

    setSaving(true);
    setSaveSuccess(false);
    setSaveError(null);

    try {
      const generateResponse = await fetch('/api/generate-checkpoint-mapping', { method: 'POST' });
      const generateData = await generateResponse.json();
      if (!generateData.success) {
        setSaveError(
          `Failed to generate checkpoint mapping from cluster: ${generateData.error || 'Unknown error'}`
        );
        setSaving(false);
        return;
      }

      const response = await fetch('/api/update-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environment: selectedEnvironment,
          namespace,
          apiKey,
          apiDomain,
          uiDomain,
        }),
      });
      const data = await response.json();

      if (data.success) {
        setSaveSuccess(true);
        setTimeout(() => window.location.reload(), 1000);
      } else {
        setSaveError(data.error || 'Failed to save configuration');
      }
    } catch (error) {
      console.error('Error saving configuration:', error);
      setSaveError('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleGetApiKey = async () => {
    setShowApiKeyInstructionsDialog(true);
    setLoadingCredentials(true);
    setCredentialsError(null);
    setKeycloakUsername('');
    setKeycloakPassword('');
    setShowPassword(false);

    if (!selectedEnvironment) {
      setCredentialsError('Please select an environment first');
      setLoadingCredentials(false);
      return;
    }

    try {
      const response = await fetch('/api/get-keycloak-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: selectedEnvironment }),
      });
      const data = await response.json();
      if (data.success) {
        setKeycloakUsername(data.username);
        setKeycloakPassword(data.password);
      } else {
        setCredentialsError(data.error || 'Failed to retrieve credentials');
      }
    } catch (error) {
      console.error('Error fetching credentials:', error);
      setCredentialsError('Failed to retrieve credentials');
    } finally {
      setLoadingCredentials(false);
    }
  };

  const handleAppConfigCreated = () => {
    window.location.reload();
  };

  const handleOpenInstallDialog = useCallback(() => {
    const nextVersion = getNextVersion(fullHelmVersion, minimumHelmVersion);
    const defaultYaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: sambastack
  labels:
    sambastack-installer: "true"
data:
  sambastack.yaml: |
    version: ${nextVersion}                     # [CHANGE ME] Helm version of sambastack to install`;
    setInstallYaml(defaultYaml);
    setInstallOutput('');
    setInstallError(null);
    setInstallationComplete(false);
    setYamlModifiedAfterInstall(false);
    setShowInstallDialog(true);
  }, [fullHelmVersion, minimumHelmVersion]);


  const handleCloseInstallDialog = useCallback(() => {
    setShowInstallDialog(false);
    setInstallOutput('');
    setInstallError(null);
    setShowInstallerLogs(false);
    setInstallationComplete(false);
    window.location.reload();
  }, []);

  const handleInstallYamlChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInstallYaml(event.target.value);
    setYamlModifiedAfterInstall(true);
    if (installationComplete) {
      setInstallationComplete(false);
      setShowInstallerLogs(false);
      setInstallOutput('');
      setInstallError(null);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    setInstallOutput('');
    setShowInstallerLogs(false);
    setInstallationComplete(false);

    try {
      const response = await fetch('/api/install-sambastack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: installYaml }),
      });
      const data = await response.json();
      if (data.success) {
        setInstallOutput(data.output || 'Installation initiated successfully!');
        setShowInstallerLogs(true);
      } else {
        setInstallError(data.error || 'Installation failed');
        if (data.stderr) setInstallOutput(data.stderr);
        else if (data.stdout) setInstallOutput(data.stdout);
      }
    } catch (error) {
      console.error('Error installing SambaStack:', error);
      setInstallError('Failed to install SambaStack');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <Suspense>
        <SearchParamsWatcher onOpenUpgrade={handleOpenInstallDialog} />
      </Suspense>

      <DocumentationPanel docFile="home.md" />

      {/* Prerequisites Missing Dialog */}
      <Dialog open={showPrerequisiteDialog} onOpenChange={setShowPrerequisiteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prerequisites Missing</DialogTitle>
            <DialogDescription>
              Please install the required tools and restart the application.
            </DialogDescription>
          </DialogHeader>
          {prerequisiteWarning && (
            <Alert variant="destructive">
              <AlertDescription>{prerequisiteWarning}</AlertDescription>
            </Alert>
          )}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <AppConfigDialog
        open={showAppConfigDialog}
        onClose={() => setShowAppConfigDialog(false)}
        onConfigCreated={handleAppConfigCreated}
      />

      <NoKubeconfigsDialog
        open={showNoKubeconfigsDialog}
        onClose={() => setShowNoKubeconfigsDialog(false)}
      />

      {/* API Key Instructions Dialog */}
      <Dialog
        open={showApiKeyInstructionsDialog}
        onOpenChange={setShowApiKeyInstructionsDialog}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API Key Instructions</DialogTitle>
            <DialogDescription>
              Login to the following UI domain using the credentials below to create your API key.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {loadingCredentials && (
              <div className="flex justify-center py-4">
                <Loader2 className="size-8 animate-spin text-primary" />
              </div>
            )}

            {credentialsError && (
              <Alert variant="destructive">
                <AlertDescription>{credentialsError}</AlertDescription>
              </Alert>
            )}

            {!loadingCredentials && uiDomain && (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">UI Domain:</p>
                <a
                  href={uiDomain}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-sm text-primary underline underline-offset-4 hover:text-primary/80"
                >
                  {uiDomain}
                </a>
              </div>
            )}

            {!loadingCredentials && keycloakUsername && keycloakPassword && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold">Username:</p>
                  <div className="flex items-center gap-2">
                    <Input
                      id={keycloakUsernameId}
                      value={keycloakUsername}
                      readOnly
                      className="font-mono"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleCopyToClipboard(keycloakUsername)}
                    >
                      <Copy />
                      <span className="sr-only">Copy username</span>
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold">Password:</p>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Input
                        id={keycloakPasswordId}
                        type={showPassword ? 'text' : 'password'}
                        value={keycloakPassword}
                        readOnly
                        className="font-mono pr-10"
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff /> : <Eye />}
                        <span className="sr-only">Toggle password visibility</span>
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleCopyToClipboard(keycloakPassword)}
                    >
                      <Copy />
                      <span className="sr-only">Copy password</span>
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {!loadingCredentials && !uiDomain && (
              <Alert>
                <AlertDescription>
                  Please select an environment with a UI domain configured.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      {/* Upgrade SambaStack Dialog */}
      <Dialog
        open={showInstallDialog}
        onOpenChange={(open) => {
          if (!open) handleCloseInstallDialog();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upgrade SambaStack</DialogTitle>
            <DialogDescription>
              Install Environment:{' '}
              <span className="font-semibold text-foreground">{selectedEnvironment}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                Please update the SambaStack helm version below to the version you want installed
              </span>
              <Tooltip>
                <TooltipTrigger>
                  <TriangleAlert className="size-4 text-amber-500" />
                </TooltipTrigger>
                <TooltipContent>
                  Please do not modify anything else unless you know what you are doing.
                </TooltipContent>
              </Tooltip>
            </div>

            <Textarea
              id={installYamlId}
              value={installYaml}
              onChange={handleInstallYamlChange}
              rows={12}
              className="font-mono text-sm"
            />

            {installError && (
              <Alert variant="destructive">
                <AlertDescription>{installError}</AlertDescription>
              </Alert>
            )}

            {installOutput && (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">Output:</p>
                <div className="max-h-48 overflow-auto rounded-lg border bg-muted p-3">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {installOutput}
                  </pre>
                </div>
              </div>
            )}

            {showInstallerLogs && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold">Installer Logs:</p>
                <div className="max-h-96 min-h-48 overflow-auto rounded-lg bg-black p-3">
                  <pre className="whitespace-pre font-mono text-sm text-white">
                    {installerLogs || 'Waiting for logs...'}
                  </pre>
                </div>
                {!installationComplete && (
                  <p className="text-xs text-muted-foreground">Auto-refreshing every 3 seconds</p>
                )}
                {installationComplete && (
                  <Alert className="border-green-500/50 bg-green-500/10">
                    <AlertDescription className="text-green-700">
                      Installation complete! You may close this dialog now to apply the changes.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              onClick={handleInstall}
              disabled={
                installing ||
                (showInstallerLogs && !installationComplete) ||
                !installYaml.trim() ||
                (installationComplete && !yamlModifiedAfterInstall)
              }
            >
              {installing && <Loader2 data-icon="inline-start" className="animate-spin" />}
              {installing ? 'Installing...' : 'Install'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Main Content */}
      <div className="flex min-h-[calc(100vh-100px)] flex-col items-center justify-center py-8">
        {/* Hero Section */}
        <div className="mb-6 max-w-2xl text-center">
          <h1 className="mb-3 bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-5xl font-bold text-transparent">
            SambaWiz
          </h1>
          <p className="mb-2 text-xl text-muted-foreground">
            Your SambaStack Bundle Configuration Wizard
          </p>
          <p className="text-sm text-muted-foreground">
            Create, configure, deploy, and test model bundles with ease!
          </p>
        </div>

        {/* Helm Version */}
        {fullHelmVersion && (
          <div className="mb-6 flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Current SambaStack Helm Version:{' '}
              <span
                className={cn(
                  'font-mono font-medium',
                  helmVersionTooOld ? 'text-destructive' : 'text-primary'
                )}
              >
                {fullHelmVersion}
              </span>
            </p>
            {(helmVersionTooOld || enableUpdates) && (
              <Button variant="outline" size="sm" onClick={handleOpenInstallDialog}>
                Upgrade
              </Button>
            )}
          </div>
        )}

        {/* Environment Config Card */}
        <Card className="w-full max-w-lg">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-primary">Select your SambaStack environment</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/add-environment')}
              >
                Add an Environment
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>Environment</FieldLabel>
                <Select value={selectedEnvironment} onValueChange={handleEnvironmentChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select environment..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {environments.length === 0 ? (
                        <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                          No environments available
                        </div>
                      ) : (
                        environments.map((env) => (
                          <SelectItem key={env} value={env}>
                            {env}
                          </SelectItem>
                        ))
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor={namespaceId}>Namespace</FieldLabel>
                <Input
                  id={namespaceId}
                  value={namespace}
                  onChange={(e) => {
                    setNamespace(e.target.value);
                    setSaveSuccess(false);
                    setSaveError(null);
                  }}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={apiDomainId}>API Domain</FieldLabel>
                <Input
                  id={apiDomainId}
                  value={apiDomain}
                  onChange={(e) => {
                    setApiDomain(e.target.value);
                    setSaveSuccess(false);
                    setSaveError(null);
                  }}
                  placeholder="https://api.example.com"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={uiDomainId}>UI Domain</FieldLabel>
                <Input
                  id={uiDomainId}
                  value={uiDomain}
                  onChange={(e) => {
                    setUiDomain(e.target.value);
                    setSaveSuccess(false);
                    setSaveError(null);
                  }}
                  placeholder="https://ui.example.com"
                />
              </Field>

              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor={apiKeyId}>API Key</FieldLabel>
                  <button
                    type="button"
                    onClick={handleGetApiKey}
                    className="text-xs text-primary underline underline-offset-4 hover:text-primary/80"
                  >
                    Get API Key
                  </button>
                </div>
                <div className="relative">
                  <Input
                    id={apiKeyId}
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setSaveSuccess(false);
                      setSaveError(null);
                    }}
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={() => setShowApiKey(!showApiKey)}
                    aria-label="Toggle API key visibility"
                  >
                    {showApiKey ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
              </Field>
            </FieldGroup>

            {saveSuccess && (
              <Alert className="mt-4 border-green-500/50 bg-green-500/10">
                <AlertDescription className="text-green-700">
                  Configuration saved successfully!
                </AlertDescription>
              </Alert>
            )}
            {saveError && (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter>
            <Button
              className="w-full"
              size="lg"
              onClick={handleApply}
              disabled={saving || !selectedEnvironment || !namespace}
            >
              {saving && <Loader2 data-icon="inline-start" className="animate-spin" />}
              {saving ? 'Applying...' : 'Apply Configuration'}
            </Button>
          </CardFooter>
        </Card>

        <p className="mt-8 text-sm text-muted-foreground">
          Ready to build? Use the navigation menu to access the bundle builder and deployment tools.
        </p>
      </div>
    </>
  );
}

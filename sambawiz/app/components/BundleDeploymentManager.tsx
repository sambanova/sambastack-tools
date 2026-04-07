'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  RefreshCw,
  Copy,
  Rocket,
  Save,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  HelpCircle,
  Loader2,
} from 'lucide-react';
import { Field, FieldLabel, FieldGroup, FieldDescription } from '@/components/ui/field';
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
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress, ProgressTrack, ProgressIndicator } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import DocumentationPanel from './DocumentationPanel';

interface BundleDeployment {
  name: string;
  namespace: string;
  bundle: string;
  creationTimestamp: string;
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      reason: string;
      message: string;
    }>;
  };
}

interface Bundle {
  name: string;
  namespace: string;
  template: string;
  creationTimestamp: string;
  isValid: boolean;
  validationReason: string;
  validationMessage: string;
  models: Record<string, unknown>;
}

interface PodStatusInfo {
  ready: number;
  total: number;
  status: string;
}

/**
 * Determines the deployment status of a bundle based on its cache and default pod status.
 */
export function getBundleDeploymentStatus(
  cachePod: PodStatusInfo | null,
  defaultPod: PodStatusInfo | null
): 'Deployed' | 'Deploying' | 'Not Deployed' {
  if (!cachePod && !defaultPod) return 'Not Deployed';
  if (cachePod && cachePod.ready < cachePod.total) return 'Deploying';
  if (defaultPod && defaultPod.ready < defaultPod.total) return 'Deploying';
  const cacheReady = cachePod ? cachePod.ready === cachePod.total : false;
  const defaultReady = defaultPod ? defaultPod.ready === defaultPod.total : false;
  if (cacheReady && defaultReady) return 'Deployed';
  return 'Deploying';
}

function StatusBadge({ status }: { status: 'Deployed' | 'Deploying' | 'Not Deployed' | 'Loading...' }) {
  if (status === 'Deployed') {
    return (
      <Badge className="border-green-500/30 bg-green-500/10 text-green-700">
        Deployed
      </Badge>
    );
  }
  if (status === 'Deploying') {
    return (
      <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-700">
        Deploying
      </Badge>
    );
  }
  if (status === 'Not Deployed') {
    return <Badge variant="secondary">Not Deployed</Badge>;
  }
  return <Badge variant="secondary">Loading...</Badge>;
}

export default function BundleDeploymentManager() {
  const searchParams = useSearchParams();
  const [bundleDeployments, setBundleDeployments] = useState<BundleDeployment[]>([]);
  const [deploymentToDelete, setDeploymentToDelete] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  const [validBundles, setValidBundles] = useState<Bundle[]>([]);
  const [selectedBundle, setSelectedBundle] = useState<string>('');
  const [deploymentName, setDeploymentName] = useState<string>('');
  const [loadingBundles, setLoadingBundles] = useState<boolean>(false);
  const [deploymentYaml, setDeploymentYaml] = useState<string>('');
  const [copiedYaml, setCopiedYaml] = useState<boolean>(false);
  const [deploying, setDeploying] = useState<boolean>(false);
  const [deploymentResult, setDeploymentResult] = useState<{
    success: boolean;
    message: string;
    output?: string;
  } | null>(null);

  const [podLogs, setPodLogs] = useState<string>('');
  const [podLogsError, setPodLogsError] = useState<string | null>(null);
  const [defaultPodLogs, setDefaultPodLogs] = useState<string>('');
  const [defaultPodLogsError, setDefaultPodLogsError] = useState<string | null>(null);
  const [monitoredDeployment, setMonitoredDeployment] = useState<string>('');
  const [showCacheLogs, setShowCacheLogs] = useState<boolean>(false);
  const [showDefaultLogs, setShowDefaultLogs] = useState<boolean>(false);
  const [podStatus, setPodStatus] = useState<{
    cachePod: PodStatusInfo | null;
    defaultPod: PodStatusInfo | null;
  }>({ cachePod: null, defaultPod: null });
  const [allDeploymentStatuses, setAllDeploymentStatuses] = useState<
    Record<string, { cachePod: PodStatusInfo | null; defaultPod: PodStatusInfo | null }>
  >({});

  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  const fetchAllDeploymentStatuses = async (deployments: BundleDeployment[]) => {
    const statuses: Record<
      string,
      { cachePod: PodStatusInfo | null; defaultPod: PodStatusInfo | null }
    > = {};
    await Promise.all(
      deployments.map(async (deployment) => {
        try {
          const response = await fetch(`/api/pod-status?deploymentName=${deployment.name}`);
          const data = await response.json();
          statuses[deployment.name] = data.success
            ? data.podStatus
            : { cachePod: null, defaultPod: null };
        } catch {
          statuses[deployment.name] = { cachePod: null, defaultPod: null };
        }
      })
    );
    setAllDeploymentStatuses(statuses);
  };

  const fetchBundleDeployments = async () => {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const response = await fetch('/api/bundle-deployment');
      const data = await response.json();
      if (data.success) {
        setBundleDeployments(data.bundleDeployments);
        await fetchAllDeploymentStatuses(data.bundleDeployments);
      } else {
        setError(data.error || 'Failed to fetch bundle deployments');
      }
    } catch (err) {
      setError('Failed to connect to the server');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchBundles = async () => {
    setLoadingBundles(true);
    try {
      const response = await fetch('/api/bundles');
      const data = await response.json();
      if (data.success) {
        setValidBundles(data.bundles.filter((b: Bundle) => b.isValid));
      }
    } catch (err) {
      console.error('Failed to connect to the server', err);
    } finally {
      setLoadingBundles(false);
    }
  };

  const loadSavedState = async () => {
    try {
      const response = await fetch('/api/bundle-deployment-state');
      const data = await response.json();
      if (data.success && data.state) {
        setSelectedBundle(data.state.selectedBundle || '');
        setDeploymentName(data.state.deploymentName || '');
        setDeploymentYaml(data.state.deploymentYaml || '');
        setMonitoredDeployment(data.state.monitoredDeployment || '');
      }
    } catch (error) {
      console.error('Failed to load saved deployment state:', error);
    }
  };

  useEffect(() => {
    fetchBundleDeployments();
    fetchBundles();
    if (!searchParams.get('bundle')) {
      loadSavedState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const bundleParam = searchParams.get('bundle');
    if (bundleParam && validBundles.length > 0) {
      const bundleExists = validBundles.some((bundle) => bundle.name === bundleParam);
      if (bundleExists) {
        setMonitoredDeployment('');
        setSelectedBundle(bundleParam);
        let suggestedName = bundleParam.startsWith('b-')
          ? bundleParam.replace('b-', 'bd-')
          : `bd-${bundleParam}`;
        setDeploymentName(suggestedName);
        setDeploymentYaml(generateDeploymentYaml(bundleParam, suggestedName));
        setDeploymentResult(null);
      }
    }
  }, [searchParams, validBundles]);

  const adaptiveDelay = (elapsedMs: number) => {
    if (elapsedMs < 6000) return 6000;
    if (elapsedMs < 12000) return 12000;
    return 24000;
  };

  // Auto-refresh cache pod logs with adaptive back-off
  useEffect(() => {
    if (!monitoredDeployment) {
      setPodLogs('');
      setPodLogsError(null);
      return;
    }
    const active = { current: true };
    let timeoutId: ReturnType<typeof setTimeout>;
    const run = async () => {
      if (!active.current) return;
      const podName = `inf-${monitoredDeployment}-cache-0`;
      const start = Date.now();
      try {
        const response = await fetch(`/api/pod-logs?podName=${podName}&lines=5`);
        const data = await response.json();
        if (data.success) {
          setPodLogs(data.logs);
          setPodLogsError(null);
        } else {
          setPodLogsError(data.message || 'Failed to fetch logs');
        }
      } catch {
        setPodLogsError('Failed to connect to the server');
      }
      if (active.current) timeoutId = setTimeout(run, adaptiveDelay(Date.now() - start));
    };
    run();
    return () => {
      active.current = false;
      clearTimeout(timeoutId);
    };
  }, [monitoredDeployment]);

  // Auto-refresh default pod logs with adaptive back-off
  useEffect(() => {
    if (!monitoredDeployment) {
      setDefaultPodLogs('');
      setDefaultPodLogsError(null);
      return;
    }
    const active = { current: true };
    let timeoutId: ReturnType<typeof setTimeout>;
    const run = async () => {
      if (!active.current) return;
      const podName = `inf-${monitoredDeployment}-q-default-n-0`;
      const start = Date.now();
      try {
        const response = await fetch(
          `/api/pod-logs?podName=${podName}&lines=5&container=inf`
        );
        const data = await response.json();
        if (data.success) {
          const logs = data.logs.trim();
          const lastWord = logs.split(/\s+/).pop();
          setDefaultPodLogs(
            lastWord === 'PodInitializing' ? 'Pod Initializing... Waiting to show logs' : logs
          );
          setDefaultPodLogsError(null);
        } else {
          setDefaultPodLogsError(data.message || 'Failed to fetch logs');
        }
      } catch {
        setDefaultPodLogsError('Failed to connect to the server');
      }
      if (active.current) timeoutId = setTimeout(run, adaptiveDelay(Date.now() - start));
    };
    run();
    return () => {
      active.current = false;
      clearTimeout(timeoutId);
    };
  }, [monitoredDeployment]);

  // Auto-refresh pod status with adaptive back-off
  useEffect(() => {
    if (!monitoredDeployment) {
      setPodStatus({ cachePod: null, defaultPod: null });
      return;
    }
    const active = { current: true };
    let timeoutId: ReturnType<typeof setTimeout>;
    const run = async () => {
      if (!active.current) return;
      const start = Date.now();
      try {
        const response = await fetch(`/api/pod-status?deploymentName=${monitoredDeployment}`);
        const data = await response.json();
        if (data.success) setPodStatus(data.podStatus);
      } catch (err) {
        console.error('Failed to fetch pod status:', err);
      }
      if (active.current) timeoutId = setTimeout(run, adaptiveDelay(Date.now() - start));
    };
    run();
    return () => {
      active.current = false;
      clearTimeout(timeoutId);
    };
  }, [monitoredDeployment]);

  const generateDeploymentYaml = (bundleName: string, deploymentName: string): string => {
    return `apiVersion: sambanova.ai/v1alpha1
kind: BundleDeployment
metadata:
  name: ${deploymentName}
spec:
  bundle: ${bundleName}
  groups:
  - minReplicas: 1
    name: default
    qosList:
    - free
  owner: no-reply@sambanova.ai
  secretNames:
  - sambanova-artifact-reader
  engineConfig:
    startupTimeout: 7200`;
  };

  const handleBundleChange = (bundleName: string | null) => {
    if (!bundleName) return;
    setSelectedBundle(bundleName);
    if (bundleName) {
      const suggestedName = bundleName.startsWith('b-')
        ? bundleName.replace('b-', 'bd-')
        : `bd-${bundleName}`;
      setDeploymentName(suggestedName);
      setDeploymentYaml(generateDeploymentYaml(bundleName, suggestedName));
    } else {
      setDeploymentName('');
      setDeploymentYaml('');
    }
  };

  const handleDeploymentNameChange = (newName: string) => {
    setDeploymentName(newName);
    if (selectedBundle && newName) {
      setDeploymentYaml(generateDeploymentYaml(selectedBundle, newName));
    }
  };

  const handleCopyYaml = async () => {
    try {
      await navigator.clipboard.writeText(deploymentYaml);
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const handleDeploy = async () => {
    if (!deploymentYaml) return;
    setDeploying(true);
    setDeploymentResult(null);
    try {
      await fetch('/api/bundle-deployment-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: { selectedBundle, deploymentName, deploymentYaml, monitoredDeployment: deploymentName },
        }),
      });
    } catch (error) {
      console.error('Failed to save deployment state:', error);
    }
    try {
      const response = await fetch('/api/deploy-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: deploymentYaml }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setDeploymentResult({ success: true, message: 'Bundle deployment applied successfully!', output: data.output });
        setMonitoredDeployment(deploymentName);
        await fetchBundleDeployments();
      } else {
        setDeploymentResult({
          success: false,
          message: data.error || 'Deployment failed',
          output: data.stderr || data.stdout || data.message || '',
        });
      }
    } catch (err) {
      setDeploymentResult({
        success: false,
        message: 'Failed to connect to deployment service',
        output: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setDeploying(false);
    }
  };

  const handleDeleteClick = (name: string) => {
    setDeploymentToDelete(name);
    setDeleteDialogOpen(true);
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setDeploymentToDelete(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deploymentToDelete) return;
    setDeleteDialogOpen(false);
    setDeleting(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const response = await fetch('/api/bundle-deployment', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: deploymentToDelete }),
      });
      const data = await response.json();
      if (data.success) {
        setSuccessMessage(`Successfully deleted ${deploymentToDelete}`);
        if (monitoredDeployment === deploymentToDelete) setMonitoredDeployment('');
      } else {
        setError(`Failed to delete ${deploymentToDelete}: ${data.error}`);
      }
      await fetchBundleDeployments();
    } catch (err) {
      setError('Failed to delete bundle deployment');
      console.error(err);
    } finally {
      setDeleting(false);
      setDeploymentToDelete(null);
    }
  };

  const handleSaveClick = () => {
    setSaveResult(null);
    setSaveDialogOpen(false);
    handleSaveFile(false);
  };

  const handleSaveFile = async (overwrite: boolean) => {
    if (!deploymentYaml || !deploymentName) return;
    setIsSaving(true);
    setSaveResult(null);
    const fileName = `${deploymentName}.yaml`;
    try {
      const response = await fetch('/api/save-artifact', {
        method: overwrite ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, content: deploymentYaml }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setSaveResult({ success: true, message: `Bundle deployment saved to saved_artifacts/${fileName}` });
      } else if (response.status === 409 && data.fileExists) {
        setSaveDialogOpen(true);
      } else {
        setSaveResult({ success: false, message: data.error || 'Failed to save bundle deployment' });
      }
    } catch {
      setSaveResult({ success: false, message: 'Failed to connect to save service' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleOverwrite = () => {
    setSaveDialogOpen(false);
    handleSaveFile(true);
  };

  const handleCancelSave = () => {
    setSaveDialogOpen(false);
  };

  const getStatusForDeployment = (deployment: BundleDeployment): 'Deployed' | 'Deploying' | 'Not Deployed' | 'Loading...' => {
    const info = allDeploymentStatuses[deployment.name];
    if (!info) return 'Loading...';
    return getBundleDeploymentStatus(info.cachePod, info.defaultPod);
  };

  return (
    <div className="flex flex-col gap-4">
      <DocumentationPanel docFile="bundle-deployment.md" />

      {/* Section 1: Existing Bundle Deployments */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>1. Check for existing Bundle Deployments</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchBundleDeployments}
              disabled={loading || deleting}
            >
              {loading ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCw data-icon="inline-start" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {successMessage && (
            <Alert className="border-green-500/50 bg-green-500/10">
              <AlertDescription className="text-green-700">{successMessage}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading && (
            <div className="flex justify-center py-6">
              <Loader2 className="size-8 animate-spin text-primary" />
            </div>
          )}

          {!loading && bundleDeployments.length === 0 && (
            <Alert>
              <AlertDescription>No bundle deployments found in the namespace.</AlertDescription>
            </Alert>
          )}

          {!loading && bundleDeployments.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-semibold">Name</TableHead>
                  <TableHead className="font-semibold">Bundle</TableHead>
                  <TableHead className="font-semibold">Status</TableHead>
                  <TableHead className="font-semibold">Created</TableHead>
                  <TableHead className="font-semibold">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bundleDeployments.map((deployment) => (
                  <TableRow key={deployment.name}>
                    <TableCell className="font-mono text-sm">{deployment.name}</TableCell>
                    <TableCell>{deployment.bundle}</TableCell>
                    <TableCell>
                      <StatusBadge status={getStatusForDeployment(deployment)} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(deployment.creationTimestamp).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMonitoredDeployment(deployment.name)}
                        >
                          Status
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-destructive/50 text-destructive hover:bg-destructive/10"
                          onClick={() => handleDeleteClick(deployment.name)}
                          disabled={deleting}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Deploy a Bundle */}
      <Card>
        <CardHeader>
          <CardTitle>2. Deploy a Bundle</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loadingBundles && (
            <div className="flex justify-center py-4">
              <Loader2 className="size-8 animate-spin text-primary" />
            </div>
          )}

          {!loadingBundles && validBundles.length === 0 && (
            <Alert>
              <AlertDescription>
                No valid bundles found. Please create and validate a bundle first.
              </AlertDescription>
            </Alert>
          )}

          {!loadingBundles && validBundles.length > 0 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <span>Select a valid bundle to deploy</span>
                <Tooltip>
                  <TooltipTrigger>
                    <HelpCircle className="size-4 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Only bundles for which validation succeeded are listed here. If you would like
                    to deploy a different bundle or see which models/configurations are available,
                    please use the &apos;load&apos; feature in Bundle Builder and select
                    &apos;Remote Environment&apos; as the source.
                  </TooltipContent>
                </Tooltip>
              </div>

              <FieldGroup>
                <Field>
                  <FieldLabel>Bundle</FieldLabel>
                  <Select value={selectedBundle} onValueChange={handleBundleChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a bundle..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {validBundles.map((bundle) => (
                          <SelectItem key={bundle.name} value={bundle.name}>
                            {bundle.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>

              {selectedBundle && (
                <div className="flex flex-col gap-4">
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Deployment Name</FieldLabel>
                      <Input
                        value={deploymentName}
                        onChange={(e) => handleDeploymentNameChange(e.target.value)}
                      />
                      <FieldDescription>
                        Enter the name for this bundle deployment (e.g., bd-your-bundle-name)
                      </FieldDescription>
                    </Field>
                  </FieldGroup>

                  {deploymentName && deploymentName !== deploymentName.toLowerCase() && (
                    <p className="text-xs text-destructive">
                      Warning: Deployment name should be in lowercase
                    </p>
                  )}

                  {/* Generated YAML */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Generated YAML</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyYaml}
                        disabled={!deploymentYaml}
                        className={cn(copiedYaml && 'text-green-600')}
                      >
                        <Copy data-icon="inline-start" />
                        {copiedYaml ? 'Copied!' : 'Copy'}
                      </Button>
                    </div>
                    <Textarea
                      rows={15}
                      value={deploymentYaml}
                      onChange={(e) => setDeploymentYaml(e.target.value)}
                      className="font-mono text-sm"
                    />
                  </div>

                  {deploymentResult && (
                    <Alert
                      variant={deploymentResult.success ? 'default' : 'destructive'}
                      className={cn(
                        deploymentResult.success && 'border-green-500/50 bg-green-500/10'
                      )}
                    >
                      <AlertDescription>
                        <p
                          className={cn(
                            'font-semibold',
                            deploymentResult.success && 'text-green-700'
                          )}
                        >
                          {deploymentResult.message}
                        </p>
                        {deploymentResult.output && (
                          <pre className="mt-2 max-h-36 overflow-auto rounded bg-black/5 p-2 font-mono text-xs">
                            {deploymentResult.output}
                          </pre>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}

                  {saveResult && (
                    <Alert
                      variant={saveResult.success ? 'default' : 'destructive'}
                      className={cn(saveResult.success && 'border-green-500/50 bg-green-500/10')}
                    >
                      <AlertDescription
                        className={cn(saveResult.success && 'text-green-700')}
                      >
                        {saveResult.message}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="flex justify-end gap-3">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleSaveClick}
                      disabled={isSaving || !deploymentYaml || !deploymentName}
                    >
                      {isSaving ? (
                        <Loader2 data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <Save data-icon="inline-start" />
                      )}
                      {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      size="lg"
                      onClick={handleDeploy}
                      disabled={deploying || !deploymentYaml}
                    >
                      {deploying ? (
                        <Loader2 data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <Rocket data-icon="inline-start" />
                      )}
                      {deploying ? 'Deploying...' : 'Deploy'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 3: Deployment Status */}
      {monitoredDeployment && (
        <Card>
          <CardHeader>
            <CardTitle>3. Check Deployment Status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <p className="text-sm font-semibold">Pod Status</p>

            {/* Cache Pod */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Cache Pod</span>
                  {podStatus.cachePod && (
                    <span className="font-mono text-xs text-muted-foreground">
                      (inf-{monitoredDeployment}-cache-0)
                    </span>
                  )}
                </div>
                {podStatus.cachePod && (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">
                      {podStatus.cachePod.ready}/{podStatus.cachePod.total}
                    </span>
                    {podStatus.cachePod.ready === podStatus.cachePod.total ? (
                      <CheckCircle2 className="size-5 text-green-600" />
                    ) : (
                      <Loader2 className="size-4 animate-spin text-primary" />
                    )}
                  </div>
                )}
              </div>

              {podStatus.cachePod ? (
                <div className="flex flex-col gap-1">
                  <Progress
                    value={(podStatus.cachePod.ready / podStatus.cachePod.total) * 100}
                  >
                    <ProgressTrack
                      className={cn(
                        'h-2',
                        podStatus.cachePod.ready === podStatus.cachePod.total &&
                          '[&>[data-slot=progress-indicator]]:bg-green-600'
                      )}
                    >
                      <ProgressIndicator />
                    </ProgressTrack>
                  </Progress>
                  <div className="flex justify-between">
                    <span className="text-xs text-muted-foreground">
                      Status: {podStatus.cachePod.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {Math.round((podStatus.cachePod.ready / podStatus.cachePod.total) * 100)}%
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Waiting for pod...</span>
                </div>
              )}

              <button
                type="button"
                className="flex items-center gap-2 rounded-md p-1 text-sm font-medium hover:bg-accent"
                onClick={() => setShowCacheLogs(!showCacheLogs)}
              >
                {showCacheLogs ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
                Show logs (last 5 lines)
              </button>

              {showCacheLogs && (
                <div className="flex flex-col gap-2 pl-4">
                  <p className="font-mono text-xs text-muted-foreground">
                    Monitoring: inf-{monitoredDeployment}-cache-0
                  </p>
                  {podLogsError ? (
                    <Alert variant="destructive">
                      <AlertDescription>{podLogsError}</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="max-h-72 min-h-28 overflow-auto rounded-lg bg-black p-3">
                      <pre className="whitespace-pre font-mono text-sm text-white">
                        {podLogs || 'Waiting for logs...'}
                      </pre>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">Auto-refreshing (adaptive)</p>
                </div>
              )}
            </div>

            <Separator />

            {/* Default Pod */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Default Pod</span>
                  {podStatus.defaultPod && (
                    <span className="font-mono text-xs text-muted-foreground">
                      (inf-{monitoredDeployment}-q-default-n-0)
                    </span>
                  )}
                </div>
                {podStatus.defaultPod && (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">
                      {podStatus.defaultPod.ready}/{podStatus.defaultPod.total}
                    </span>
                    {podStatus.defaultPod.ready === podStatus.defaultPod.total ? (
                      <CheckCircle2 className="size-5 text-green-600" />
                    ) : (
                      <Loader2 className="size-4 animate-spin text-primary" />
                    )}
                  </div>
                )}
              </div>

              {podStatus.defaultPod ? (
                <div className="flex flex-col gap-1">
                  <Progress
                    value={(podStatus.defaultPod.ready / podStatus.defaultPod.total) * 100}
                  >
                    <ProgressTrack
                      className={cn(
                        'h-2',
                        podStatus.defaultPod.ready === podStatus.defaultPod.total &&
                          '[&>[data-slot=progress-indicator]]:bg-green-600'
                      )}
                    >
                      <ProgressIndicator />
                    </ProgressTrack>
                  </Progress>
                  <div className="flex justify-between">
                    <span className="text-xs text-muted-foreground">
                      Status: {podStatus.defaultPod.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {Math.round(
                        (podStatus.defaultPod.ready / podStatus.defaultPod.total) * 100
                      )}
                      %
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Waiting for pod...</span>
                </div>
              )}

              <button
                type="button"
                className="flex items-center gap-2 rounded-md p-1 text-sm font-medium hover:bg-accent"
                onClick={() => setShowDefaultLogs(!showDefaultLogs)}
              >
                {showDefaultLogs ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
                Show logs (last 5 lines)
              </button>

              {showDefaultLogs && (
                <div className="flex flex-col gap-2 pl-4">
                  <p className="font-mono text-xs text-muted-foreground">
                    Monitoring: inf-{monitoredDeployment}-q-default-n-0 (container: inf)
                  </p>
                  {defaultPodLogsError ? (
                    <Alert variant="destructive">
                      <AlertDescription>{defaultPodLogsError}</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="max-h-72 min-h-28 overflow-auto rounded-lg bg-black p-3">
                      <pre className="whitespace-pre font-mono text-sm text-white">
                        {defaultPodLogs || 'Waiting for logs...'}
                      </pre>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">Auto-refreshing (adaptive)</p>
                </div>
              )}
            </div>

            {/* Overall Status */}
            {podStatus.cachePod && podStatus.defaultPod && (
              <div className="rounded-lg border bg-muted/50 p-3">
                {podStatus.cachePod.ready === podStatus.cachePod.total &&
                podStatus.defaultPod.ready === podStatus.defaultPod.total ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-5 text-green-600" />
                    <span className="text-sm font-semibold text-green-700">
                      Deployment Complete! All pods are ready.
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-5 animate-spin text-primary" />
                    <span className="text-sm font-medium text-muted-foreground">
                      Deployment in progress... Waiting for all pods to be ready.
                    </span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Save Overwrite Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={(open) => { if (!open) handleCancelSave(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>File Already Exists</DialogTitle>
            <DialogDescription>
              A file named <strong>{deploymentName}.yaml</strong> already exists in
              saved_artifacts. Do you want to overwrite it?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelSave}>
              Cancel
            </Button>
            <Button onClick={handleOverwrite}>Overwrite</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={(open) => { if (!open) handleDeleteCancel(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Deletion</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the bundle deployment:{' '}
              <strong>{deploymentToDelete}</strong>?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleDeleteCancel}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteConfirm}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

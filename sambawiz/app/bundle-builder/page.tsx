'use client';

import { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import BundleForm from '../components/BundleForm';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TriangleAlert } from 'lucide-react';

type BundleSource = 'savedArtifacts' | 'deployedBundles';

export default function BundleBuilderPage() {
  const [openDialog, setOpenDialog] = useState(false);
  const [bundleSource, setBundleSource] = useState<BundleSource>('savedArtifacts');

  const [yamlFiles, setYamlFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');

  const [deployedBundles, setDeployedBundles] = useState<string[]>([]);
  const [selectedDeployedBundle, setSelectedDeployedBundle] = useState('');
  const [deployedBundlesError, setDeployedBundlesError] = useState('');

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!openDialog) return;
    const currentSelection = bundleSource === 'savedArtifacts' ? selectedFile : selectedDeployedBundle;
    const validate = async () => {
      setLoadWarning(null);
      if (!currentSelection) return;
      try {
        let data;
        if (bundleSource === 'savedArtifacts') {
          const res = await fetch(`/api/load-bundle?fileName=${encodeURIComponent(selectedFile)}`);
          data = await res.json();
        } else {
          const res = await fetch(`/api/load-deployed-bundle?bundleName=${encodeURIComponent(selectedDeployedBundle)}`);
          data = await res.json();
        }
        if (!data.success && data.error?.includes('not found in pef_configs.json')) {
          setLoadWarning(data.error);
        }
      } catch {
        // ignore pre-validation errors silently
      }
    };
    validate();
  }, [openDialog, bundleSource, selectedFile, selectedDeployedBundle]);

  useEffect(() => {
    if (openDialog && bundleSource === 'savedArtifacts') {
      fetch('/api/saved-artifacts')
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setYamlFiles(data.files);
            if (data.files.length > 0) setSelectedFile(data.files[0]);
          }
        })
        .catch(err => console.error('Error fetching saved artifacts:', err));
    }
  }, [openDialog, bundleSource]);

  useEffect(() => {
    if (openDialog && bundleSource === 'deployedBundles') {
      fetch('/api/deployed-bundles')
        .then(res => { setDeployedBundlesError(''); return res.json(); })
        .then(data => {
          if (data.success) {
            setDeployedBundles(data.bundles);
            if (data.bundles.length > 0) setSelectedDeployedBundle(data.bundles[0]);
          } else {
            setDeployedBundlesError(data.error || 'Failed to fetch deployed bundles');
          }
        })
        .catch(() => setDeployedBundlesError('Failed to fetch deployed bundles'));
    }
  }, [openDialog, bundleSource]);

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setLoadError(null);
    setLoadWarning(null);
  };

  const dispatchLoadAndClose = (data: {
    bundleName: string;
    selectedModels: string[];
    selectedConfigs: unknown[];
    draftModels: Record<string, string>;
  }) => {
    window.dispatchEvent(new CustomEvent('loadBundleState', { detail: data }));
    handleCloseDialog();
  };

  const handleLoadBundle = async () => {
    try {
      let data;
      if (bundleSource === 'savedArtifacts') {
        if (!selectedFile) return;
        const res = await fetch(`/api/load-bundle?fileName=${encodeURIComponent(selectedFile)}&convert=true`);
        data = await res.json();
      } else {
        if (!selectedDeployedBundle) return;
        const res = await fetch(`/api/load-deployed-bundle?bundleName=${encodeURIComponent(selectedDeployedBundle)}&convert=true`);
        data = await res.json();
      }
      if (data.success) {
        dispatchLoadAndClose(data);
      } else {
        setLoadError(data.error);
      }
    } catch {
      setLoadError('Failed to load bundle. Please check the console for details.');
    }
  };

  const isLoadDisabled = bundleSource === 'savedArtifacts'
    ? yamlFiles.length === 0 || !selectedFile
    : deployedBundles.length === 0 || !selectedDeployedBundle;

  return (
    <AppLayout>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Bundle Builder</h1>
        <p className="text-sm text-muted-foreground">
          Create model bundles with multiple model configurations or{' '}
          <button
            onClick={() => setOpenDialog(true)}
            className="inline-flex items-center rounded border border-primary px-2 py-0.5 text-sm text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
          >
            load
          </button>
          {' '}an existing bundle
        </p>
      </div>

      <BundleForm />

      <Dialog open={openDialog} onOpenChange={(open) => { if (!open) handleCloseDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Load Existing Bundle</DialogTitle>
            <DialogDescription>
              Choose a source and select a bundle to load its configuration.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Source selector */}
            <div className="flex gap-4">
              {(['savedArtifacts', 'deployedBundles'] as BundleSource[]).map((src) => (
                <label key={src} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="bundleSource"
                    value={src}
                    checked={bundleSource === src}
                    onChange={() => {
                      setBundleSource(src);
                      setLoadError(null);
                      setLoadWarning(null);
                    }}
                    className="accent-primary"
                  />
                  <span className="text-sm">
                    {src === 'savedArtifacts' ? 'Saved Artifacts' : 'Remote Environment'}
                  </span>
                </label>
              ))}
            </div>

            {bundleSource === 'savedArtifacts' && (
              <div className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">Select existing bundle:</p>
                <Select
                  value={selectedFile}
                  onValueChange={(v) => { if (v) { setSelectedFile(v); setLoadError(null); } }}
                  disabled={yamlFiles.length === 0}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a file..." />
                  </SelectTrigger>
                  <SelectContent>
                    {yamlFiles.map((file) => (
                      <SelectItem key={file} value={file}>{file}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {yamlFiles.length === 0 && (
                  <p className="text-sm text-muted-foreground">No saved bundles found in saved_artifacts folder</p>
                )}
              </div>
            )}

            {bundleSource === 'deployedBundles' && (
              <div className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">Select existing bundle:</p>
                <Select
                  value={selectedDeployedBundle}
                  onValueChange={(v) => { if (v) { setSelectedDeployedBundle(v); setLoadError(null); } }}
                  disabled={deployedBundles.length === 0}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a bundle..." />
                  </SelectTrigger>
                  <SelectContent>
                    {deployedBundles.map((bundle) => (
                      <SelectItem key={bundle} value={bundle}>{bundle}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {deployedBundlesError && (
                  <p className="text-sm text-destructive">{deployedBundlesError}</p>
                )}
                {!deployedBundlesError && deployedBundles.length === 0 && (
                  <p className="text-sm text-muted-foreground">No deployed bundles found in the current namespace</p>
                )}
              </div>
            )}

            {loadWarning && (
              <Alert>
                <TriangleAlert data-icon="inline-start" className="size-4 text-amber-500" />
                <AlertDescription>{loadWarning} If you proceed to load this bundle, all PEFs that are not supported will be removed.</AlertDescription>
              </Alert>
            )}
            {loadError && (
              <Alert variant="destructive">
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>Cancel</Button>
            <Button onClick={handleLoadBundle} disabled={isLoadDisabled}>Load</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

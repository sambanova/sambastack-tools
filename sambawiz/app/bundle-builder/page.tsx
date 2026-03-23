'use client';

import { useState, useEffect } from 'react';
import {
  Typography,
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  FormControl,
  Select,
  MenuItem,
  SelectChangeEvent,
  RadioGroup,
  FormControlLabel,
  Radio,
  Alert,
} from '@mui/material';
import AppLayout from '../components/AppLayout';
import BundleForm from '../components/BundleForm';

type BundleSource = 'savedArtifacts' | 'deployedBundles';

export default function BundleBuilderPage() {
  const [openDialog, setOpenDialog] = useState(false);
  const [bundleSource, setBundleSource] = useState<BundleSource>('savedArtifacts');

  // Saved Artifacts state
  const [yamlFiles, setYamlFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');

  // Deployed Bundles state
  const [deployedBundles, setDeployedBundles] = useState<string[]>([]);
  const [selectedDeployedBundle, setSelectedDeployedBundle] = useState('');
  const [deployedBundlesError, setDeployedBundlesError] = useState('');

  // Load error shown inline in the dialog (after clicking LOAD)
  const [loadError, setLoadError] = useState<string | null>(null);
  // Warning shown when the selected bundle has unsupported PEFs (pre-validation)
  const [loadWarning, setLoadWarning] = useState<string | null>(null);

  // Pre-validate the selected bundle to warn about unsupported PEFs
  useEffect(() => {
    if (!openDialog) return;
    setLoadWarning(null);

    const currentSelection = bundleSource === 'savedArtifacts' ? selectedFile : selectedDeployedBundle;
    if (!currentSelection) return;

    const validate = async () => {
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

  // Fetch saved artifacts when dialog opens with that source
  useEffect(() => {
    if (openDialog && bundleSource === 'savedArtifacts') {
      fetch('/api/saved-artifacts')
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setYamlFiles(data.files);
            if (data.files.length > 0) {
              setSelectedFile(data.files[0]);
            }
          }
        })
        .catch(err => console.error('Error fetching saved artifacts:', err));
    }
  }, [openDialog, bundleSource]);

  // Fetch deployed bundles when dialog opens with that source
  useEffect(() => {
    if (openDialog && bundleSource === 'deployedBundles') {
      fetch('/api/deployed-bundles')
        .then(res => { setDeployedBundlesError(''); return res.json(); })
        .then(data => {
          if (data.success) {
            setDeployedBundles(data.bundles);
            if (data.bundles.length > 0) {
              setSelectedDeployedBundle(data.bundles[0]);
            }
          } else {
            setDeployedBundlesError(data.error || 'Failed to fetch deployed bundles');
          }
        })
        .catch(err => {
          console.error('Error fetching deployed bundles:', err);
          setDeployedBundlesError('Failed to fetch deployed bundles');
        });
    }
  }, [openDialog, bundleSource]);

  const handleOpenDialog = () => {
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setLoadError(null);
    setLoadWarning(null);
  };

  const handleSourceChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setBundleSource(event.target.value as BundleSource);
    setLoadError(null);
    setLoadWarning(null);
  };

  const handleFileChange = (event: SelectChangeEvent) => {
    setSelectedFile(event.target.value);
    setLoadError(null);
  };

  const handleDeployedBundleChange = (event: SelectChangeEvent) => {
    setSelectedDeployedBundle(event.target.value);
    setLoadError(null);
  };

  const dispatchLoadAndClose = (data: { bundleName: string; selectedModels: string[]; selectedConfigs: unknown[]; draftModels: Record<string, string> }) => {
    window.dispatchEvent(new CustomEvent('loadBundleState', {
      detail: {
        bundleName: data.bundleName,
        selectedModels: data.selectedModels,
        selectedConfigs: data.selectedConfigs,
        draftModels: data.draftModels
      }
    }));
    handleCloseDialog();
  };

  const fetchBundle = async (convert: boolean) => {
    if (bundleSource === 'savedArtifacts') {
      if (!selectedFile) return null;
      const response = await fetch(`/api/load-bundle?fileName=${encodeURIComponent(selectedFile)}${convert ? '&convert=true' : ''}`);
      return response.json();
    } else {
      if (!selectedDeployedBundle) return null;
      const response = await fetch(`/api/load-deployed-bundle?bundleName=${encodeURIComponent(selectedDeployedBundle)}${convert ? '&convert=true' : ''}`);
      return response.json();
    }
  };

  const handleLoadBundle = async () => {
    try {
      const data = await fetchBundle(true);
      if (!data) return;

      if (data.success) {
        dispatchLoadAndClose(data);
      } else {
        console.error('Failed to load bundle:', data.error);
        setLoadError(data.error);
      }
    } catch (err) {
      console.error('Error loading bundle:', err);
      setLoadError('Failed to load bundle. Please check the console for details.');
    }
  };

  const isLoadDisabled = bundleSource === 'savedArtifacts'
    ? yamlFiles.length === 0 || !selectedFile
    : deployedBundles.length === 0 || !selectedDeployedBundle;

  return (
    <AppLayout>
      <Box>
        <Typography variant="h4" component="h1" gutterBottom sx={{ fontWeight: 600, mb: 1 }}>
          Bundle Builder
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          Create model bundles with multiple model configurations or{' '}
          <Box
            component="span"
            onClick={handleOpenDialog}
            sx={{
              cursor: 'pointer',
              padding: '2px 8px',
              border: '1px solid',
              borderColor: 'primary.main',
              borderRadius: '4px',
              color: 'primary.main',
              display: 'inline-block',
              '&:hover': {
                backgroundColor: 'primary.main',
                color: 'primary.contrastText',
              },
              transition: 'all 0.2s',
            }}
          >
            load
          </Box>
          {' '}an existing bundle
        </Typography>

        <BundleForm />
      </Box>

      {/* Load Existing Bundle Dialog */}
      <Dialog open={openDialog} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Load Existing Bundle</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              Bundle source:
            </Typography>
            <RadioGroup
              row
              value={bundleSource}
              onChange={handleSourceChange}
              sx={{ mb: 2 }}
            >
              <FormControlLabel
                value="savedArtifacts"
                control={<Radio size="small" />}
                label="Saved Artifacts"
              />
              <FormControlLabel
                value="deployedBundles"
                control={<Radio size="small" />}
                label="Remote Environment"
              />
            </RadioGroup>

            {bundleSource === 'savedArtifacts' && (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography variant="body2" sx={{ minWidth: 'fit-content' }}>
                    Select existing bundle:
                  </Typography>
                  <FormControl fullWidth size="small">
                    <Select
                      value={selectedFile}
                      onChange={handleFileChange}
                      disabled={yamlFiles.length === 0}
                    >
                      {yamlFiles.map((file) => (
                        <MenuItem key={file} value={file}>
                          {file}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>
                {yamlFiles.length === 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    No saved bundles found in saved_artifacts folder
                  </Typography>
                )}
              </>
            )}

            {bundleSource === 'deployedBundles' && (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography variant="body2" sx={{ minWidth: 'fit-content' }}>
                    Select existing bundle:
                  </Typography>
                  <FormControl fullWidth size="small">
                    <Select
                      value={selectedDeployedBundle}
                      onChange={handleDeployedBundleChange}
                      disabled={deployedBundles.length === 0}
                    >
                      {deployedBundles.map((bundle) => (
                        <MenuItem key={bundle} value={bundle}>
                          {bundle}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>
                {deployedBundlesError && (
                  <Typography variant="body2" color="error" sx={{ mt: 2 }}>
                    {deployedBundlesError}
                  </Typography>
                )}
                {!deployedBundlesError && deployedBundles.length === 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    No deployed bundles found in the current namespace
                  </Typography>
                )}
              </>
            )}
          </Box>
          {loadWarning && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {loadWarning}{' If you proceed to load this bundle, all PEFs that are not supported will be removed.'}
            </Alert>
          )}
          {loadError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {loadError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Cancel</Button>
          <Button
            onClick={handleLoadBundle}
            variant="contained"
            disabled={isLoadDisabled}
          >
            Load
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}

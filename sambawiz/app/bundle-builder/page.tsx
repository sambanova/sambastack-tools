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
  SelectChangeEvent
} from '@mui/material';
import AppLayout from '../components/AppLayout';
import BundleForm from '../components/BundleForm';

export default function BundleBuilderPage() {
  const [openDialog, setOpenDialog] = useState(false);
  const [yamlFiles, setYamlFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');

  // Fetch yaml files when dialog opens
  useEffect(() => {
    if (openDialog) {
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
  }, [openDialog]);

  const handleOpenDialog = () => {
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const handleFileChange = (event: SelectChangeEvent) => {
    setSelectedFile(event.target.value);
  };

  const handleLoadBundle = async () => {
    if (!selectedFile) return;

    try {
      // Fetch the bundle configuration from the API
      const response = await fetch(`/api/load-bundle?fileName=${encodeURIComponent(selectedFile)}`);
      const data = await response.json();

      if (data.success) {
        // Update the BundleForm state by triggering a custom event
        window.dispatchEvent(new CustomEvent('loadBundleState', {
          detail: {
            bundleName: data.bundleName,
            selectedModels: data.selectedModels,
            selectedConfigs: data.selectedConfigs,
            draftModels: data.draftModels
          }
        }));
        handleCloseDialog();
      } else {
        console.error('Failed to load bundle:', data.error);
        alert(`Failed to load bundle: ${data.error}`);
      }
    } catch (err) {
      console.error('Error loading bundle:', err);
      alert('Failed to load bundle. Please check the console for details.');
    }
  };

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
            <Typography variant="body2" sx={{ mb: 2 }}>
              Bundle source: Saved Artifacts
            </Typography>
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
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Cancel</Button>
          <Button
            onClick={handleLoadBundle}
            variant="contained"
            disabled={yamlFiles.length === 0 || !selectedFile}
          >
            Load
          </Button>
        </DialogActions>
      </Dialog>
    </AppLayout>
  );
}

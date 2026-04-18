'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';

export default function AddEnvironment() {
  const router = useRouter();

  const encodedConfigId = 'add-env-encoded-config';
  const environmentNameId = 'add-env-environment-name';

  const [encodedConfig, setEncodedConfig] = useState<string>('');
  const [environmentName, setEnvironmentName] = useState<string>('sambastack-dev-0');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [showOverwriteDialog, setShowOverwriteDialog] = useState<boolean>(false);
  const [pendingEnvironmentName, setPendingEnvironmentName] = useState<string>('');

  const handleEnvironmentNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setEnvironmentName(value);

    // Validate for whitespace
    if (/\s/.test(value)) {
      setNameError('Environment name cannot contain whitespaces');
    } else {
      setNameError(null);
    }

    setError(null);
  };

  const handleEncodedConfigChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEncodedConfig(event.target.value);
    setError(null);
  };

  const handleCancel = () => {
    router.push('/home');
  };

  const handleAdd = async (overwrite: boolean = false) => {
    // Validation
    if (!encodedConfig.trim()) {
      setError('Please provide an encoded config');
      return;
    }

    if (!environmentName.trim()) {
      setError('Please provide an environment name');
      return;
    }

    if (/\s/.test(environmentName)) {
      setError('Environment name cannot contain whitespaces');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/add-environment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          encodedConfig: encodedConfig.trim(),
          environmentName: environmentName.trim(),
          overwrite: overwrite,
        }),
      });

      const data = await response.json();

      if (data.success) {
        // Redirect to home page on success
        router.push('/home');
      } else if (data.environmentExists && !overwrite) {
        // Show confirmation dialog for overwriting
        setPendingEnvironmentName(environmentName.trim());
        setShowOverwriteDialog(true);
      } else {
        setError(data.error || 'Failed to add environment');
      }
    } catch (error) {
      console.error('Error adding environment:', error);
      setError('Failed to add environment');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmOverwrite = async () => {
    setShowOverwriteDialog(false);
    await handleAdd(true);
  };

  const handleCancelOverwrite = () => {
    setShowOverwriteDialog(false);
    setPendingEnvironmentName('');
  };

  return (
    <>
      {/* Overwrite Confirmation Dialog */}
      <Dialog
        open={showOverwriteDialog}
        onClose={handleCancelOverwrite}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Environment Already Exists</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The environment <strong>{pendingEnvironmentName}</strong> already exists.
            Do you want to overwrite its kubeconfig file?
          </DialogContentText>
          <Alert severity="info" sx={{ mt: 2 }}>
            This will replace the kubeconfig file in the kubeconfigs directory.
            No changes will be made to app-config.json.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelOverwrite} color="inherit">
            Cancel
          </Button>
          <Button
            onClick={handleConfirmOverwrite}
            variant="contained"
            color="primary"
            autoFocus
          >
            Overwrite
          </Button>
        </DialogActions>
      </Dialog>

      <Box
        sx={{
          minHeight: 'calc(100vh - 100px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          py: 4,
          px: 2,
        }}
      >
        <Paper
        elevation={3}
        sx={{
          p: 4,
          maxWidth: '700px',
          width: '100%',
          borderRadius: 3,
          background: 'linear-gradient(135deg, rgba(255, 107, 53, 0.05) 0%, rgba(255, 142, 83, 0.05) 100%)',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography
          variant="h5"
          sx={{
            mb: 3,
            fontWeight: 600,
            color: 'primary.main',
          }}
        >
          Add an Environment
        </Typography>

        {/* Encoded Config Text Area */}
        <Typography
          variant="body2"
          sx={{
            mb: 1,
            color: 'text.secondary',
          }}
        >
          Copy your encoded config here (e.g., from 1Password)
        </Typography>
        <TextField
          id={encodedConfigId}
          fullWidth
          multiline
          rows={8}
          value={encodedConfig}
          onChange={handleEncodedConfigChange}
          variant="outlined"
          placeholder="Paste your base64 encoded kubeconfig here..."
          sx={{
            mb: 3,
            '& .MuiOutlinedInput-root': {
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              '& fieldset': {
                borderColor: 'divider',
              },
              '&:hover fieldset': {
                borderColor: 'primary.main',
              },
            },
          }}
        />

        {/* Environment Name Field */}
        <Typography
          variant="body2"
          sx={{
            mb: 1,
            color: 'text.secondary',
          }}
        >
          Environment Name (no whitespaces allowed)
        </Typography>
        <TextField
          id={environmentNameId}
          fullWidth
          label="Environment Name"
          value={environmentName}
          onChange={handleEnvironmentNameChange}
          variant="outlined"
          error={!!nameError}
          helperText={nameError}
          sx={{
            mb: 3,
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                borderColor: nameError ? 'error.main' : 'divider',
              },
              '&:hover fieldset': {
                borderColor: nameError ? 'error.main' : 'primary.main',
              },
            },
          }}
        />

        {/* Error Message */}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {/* Action Buttons */}
        <Box
          sx={{
            display: 'flex',
            gap: 2,
            justifyContent: 'flex-end',
          }}
        >
          <Button
            variant="outlined"
            size="large"
            onClick={handleCancel}
            disabled={submitting}
            sx={{
              px: 4,
              fontWeight: 600,
              textTransform: 'none',
              borderColor: 'primary.main',
              color: 'primary.main',
              '&:hover': {
                borderColor: 'primary.dark',
                backgroundColor: 'rgba(255, 107, 53, 0.05)',
              },
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            size="large"
            onClick={() => handleAdd(false)}
            disabled={submitting || !!nameError || !encodedConfig.trim() || !environmentName.trim()}
            sx={{
              px: 4,
              fontWeight: 600,
              textTransform: 'none',
              background: 'linear-gradient(135deg, #FF6B35 0%, #FF8E53 100%)',
              '&:hover': {
                background: 'linear-gradient(135deg, #FF5722 0%, #FF7043 100%)',
              },
              '&:disabled': {
                background: '#ccc',
                color: '#666',
              },
            }}
          >
            {submitting ? (
              <>
                <CircularProgress size={20} sx={{ mr: 1, color: 'white' }} />
                Adding...
              </>
            ) : (
              'Add'
            )}
          </Button>
        </Box>
      </Paper>
    </Box>
    </>
  );
}

'use client';

import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Alert,
  Box,
  List,
  ListItem,
  ListItemText,
  Link,
} from '@mui/material';

interface KubeconfigErrorDialogProps {
  open: boolean;
  onClose: () => void;
  helmCommand?: string;
  errorDetails?: string;
  showUpgradeLink?: boolean;
  onUpgrade?: () => void;
}

export default function KubeconfigErrorDialog({
  open,
  onClose,
  helmCommand,
  errorDetails,
  showUpgradeLink,
  onUpgrade,
}: KubeconfigErrorDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Kubeconfig Validation Error</DialogTitle>
      <DialogContent>
        <Alert severity="error" sx={{ mb: 3 }}>
          Failed to validate kubeconfig. The environment information could not be retrieved.
        </Alert>

        {helmCommand && (
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Helm Command:
            </Typography>
            <Box
              sx={{
                p: 2,
                backgroundColor: '#f5f5f5',
                borderRadius: 1,
                fontFamily: 'monospace',
                fontSize: '0.875rem',
                overflowX: 'auto',
              }}
            >
              {helmCommand}
            </Box>
          </Box>
        )}

        {errorDetails && (
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Error Details:
            </Typography>
            <Box
              sx={{
                p: 2,
                backgroundColor: '#ffebee',
                borderRadius: 1,
                fontFamily: 'monospace',
                fontSize: '0.875rem',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {errorDetails}
            </Box>
          </Box>
        )}

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
          Possible Resolutions:
        </Typography>
        {showUpgradeLink ? (
          <List sx={{ pl: 2 }}>
            <ListItem sx={{ display: 'list-item', listStyleType: 'decimal', pl: 0 }}>
              <Box>
                <Typography variant="body1" sx={{ fontWeight: 500 }}>
                  Upgrade SambaStack version
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Upgrade your SambaStack installation to at least the minimum
                  required version using the{' '}
                  {onUpgrade ? (
                    <Link
                      component="button"
                      onClick={onUpgrade}
                      sx={{ fontWeight: 600, verticalAlign: 'baseline' }}
                    >
                      upgrade
                    </Link>
                  ) : (
                    'upgrade'
                  )}{' '}
                  wizard on the home page.
                </Typography>
              </Box>
            </ListItem>
            <ListItem sx={{ display: 'list-item', listStyleType: 'decimal', pl: 0 }}>
              <Box>
                <Typography variant="body1" sx={{ fontWeight: 500 }}>
                  Downgrade SambaWiz version
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
                  Check out a previous SambaWiz git tag whose minimum required
                  helm version (in its VERSION file) applies to this environment.
                  Browse the available tags at{' '}
                  <Link
                    href="https://github.com/sambanova/sambastack-tools/tags"
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ fontWeight: 600 }}
                  >
                    github.com/sambanova/sambastack-tools/tags
                  </Link>{' '}
                  and run, for example:
                </Typography>
                <Box
                  sx={{
                    p: 2,
                    backgroundColor: '#f5f5f5',
                    borderRadius: 1,
                    fontFamily: 'monospace',
                    fontSize: '0.875rem',
                    overflowX: 'auto',
                  }}
                >
                  git checkout SambaWiz-v1.5.4
                </Box>
              </Box>
            </ListItem>
          </List>
        ) : (
          <List sx={{ pl: 2 }}>
            <ListItem sx={{ display: 'list-item', listStyleType: 'decimal', pl: 0 }}>
              <ListItemText
                primary="Check the kubeconfig file for correctness"
                secondary="Ensure the kubeconfig file exists and is properly formatted"
              />
            </ListItem>
            <ListItem sx={{ display: 'list-item', listStyleType: 'decimal', pl: 0 }}>
              <ListItemText
                primary="Check if you have network access to the server"
                secondary="Verify that you are on the right network/VPN to access the server specified in the kubeconfig file"
              />
            </ListItem>
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained">
          OK
        </Button>
      </DialogActions>
    </Dialog>
  );
}

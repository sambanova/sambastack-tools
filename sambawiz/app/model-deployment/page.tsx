import { Typography, Box } from '@mui/material';
import AppLayout from '../components/AppLayout';
import ModelDeploymentManager from '../components/ModelDeploymentManager';

export default function ModelDeploymentPage() {
  return (
    <AppLayout>
      <Box>
        <Typography variant="h4" component="h1" gutterBottom sx={{ fontWeight: 600, mb: 1 }}>
          Model Deployment
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          Manage and monitor your model deployments
        </Typography>

        <ModelDeploymentManager />
      </Box>
    </AppLayout>
  );
}

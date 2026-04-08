import { Suspense } from 'react';
import AppLayout from '../components/AppLayout';
import BundleDeploymentManager from '../components/BundleDeploymentManager';

export default function BundleDeploymentPage() {
  return (
    <AppLayout>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Bundle Deployment</h1>
        <p className="text-sm text-muted-foreground">Manage and monitor your bundle deployments</p>
      </div>

      <Suspense>
        <BundleDeploymentManager />
      </Suspense>
    </AppLayout>
  );
}

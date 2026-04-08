'use client';

import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';

interface NoKubeconfigsDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function NoKubeconfigsDialog({ open, onClose }: NoKubeconfigsDialogProps) {
  const router = useRouter();

  const handleAddEnvironment = () => {
    router.push('/add-environment');
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>No kubeconfigs found!</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Alert className="border-amber-200 bg-amber-50 text-amber-800">
            <AlertTriangle className="size-4 text-amber-600" />
            <AlertDescription className="text-amber-800">
              No kubeconfig files were found in the kubeconfigs directory.
            </AlertDescription>
          </Alert>

          <p className="text-sm text-muted-foreground">
            To use SambaWiz, you need to provide a valid kubeconfig file. You have two options:
          </p>

          <ol className="list-decimal pl-5 flex flex-col gap-3 text-sm">
            <li>
              <p className="font-semibold">Manually copy a kubeconfig file</p>
              <p className="text-muted-foreground">
                Copy your kubeconfig YAML file into the kubeconfigs directory and refresh this page.
              </p>
            </li>
            <li>
              <p className="font-semibold">Add an environment using an encoded config</p>
              <p className="text-muted-foreground">
                Use the &apos;Add Environment&apos; page to paste an encoded kubeconfig (e.g., from
                1Password).
              </p>
            </li>
          </ol>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleRefresh}>
            Refresh Page
          </Button>
          <Button onClick={handleAddEnvironment}>
            Add Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

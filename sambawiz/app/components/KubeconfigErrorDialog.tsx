'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

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
  const renderErrorDetails = () => {
    if (!errorDetails) return null;
    if (showUpgradeLink && onUpgrade) {
      const upgradeIndex = errorDetails.indexOf('upgrade');
      if (upgradeIndex !== -1) {
        return (
          <>
            {errorDetails.slice(0, upgradeIndex)}
            <button
              onClick={onUpgrade}
              className="font-semibold underline underline-offset-2 hover:opacity-80 align-baseline"
            >
              upgrade
            </button>
            {errorDetails.slice(upgradeIndex + 'upgrade'.length)}
          </>
        );
      }
    }
    return errorDetails;
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Kubeconfig Validation Error</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertDescription>
              Failed to validate kubeconfig. The environment information could not be retrieved.
            </AlertDescription>
          </Alert>

          {helmCommand && (
            <div>
              <p className="text-sm font-semibold mb-2">Helm Command:</p>
              <div className="rounded bg-muted px-3 py-2 font-mono text-sm overflow-x-auto">
                {helmCommand}
              </div>
            </div>
          )}

          {errorDetails && (
            <div>
              <p className="text-sm font-semibold mb-2">Error Details:</p>
              <div className="rounded bg-red-50 px-3 py-2 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-words">
                {renderErrorDetails()}
              </div>
            </div>
          )}

          <div>
            <p className="text-sm font-semibold mb-2">Possible Resolutions:</p>
            <ol className="list-decimal pl-5 flex flex-col gap-3 text-sm">
              <li>
                <p className="font-medium">Check the kubeconfig file for correctness</p>
                <p className="text-muted-foreground">
                  Ensure the kubeconfig file exists and is properly formatted
                </p>
              </li>
              <li>
                <p className="font-medium">Check if you have network access to the server</p>
                <p className="text-muted-foreground">
                  Verify that you are on the right network/VPN to access the server specified in the
                  kubeconfig file
                </p>
              </li>
            </ol>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

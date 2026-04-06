'use client';

import { useState, useId } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface AppConfigDialogProps {
  open: boolean;
  onClose: () => void;
  onConfigCreated: () => void;
}

export default function AppConfigDialog({ open, onClose, onConfigCreated }: AppConfigDialogProps) {
  // Generate stable ID for form field to prevent hydration mismatches
  const checkpointsDirId = useId();

  const [checkpointsDir, setCheckpointsDir] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!checkpointsDir || checkpointsDir.trim() === '') {
      setError('Checkpoints Directory is required');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const response = await fetch('/api/check-app-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          checkpointsDir: checkpointsDir.trim(),
        }),
      });

      const data = await response.json();

      if (data.success) {
        onConfigCreated();
        onClose();
      } else {
        setError(data.error || 'Failed to create app-config.json');
      }
    } catch (err) {
      console.error('Error creating app-config.json:', err);
      setError('Failed to create app-config.json');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    if (!creating) {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>App Configuration Required</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Alert className="border-amber-200 bg-amber-50 text-amber-800">
            <AlertTriangle className="size-4 text-amber-600" />
            <AlertDescription className="text-amber-800">
              The app-config.json file does not exist or the checkpointsDir field is not populated.
              Please create the configuration file to continue.
            </AlertDescription>
          </Alert>

          <p className="text-sm text-muted-foreground">
            The app-config.json file must exist in the SambaWiz root directory and contain a valid
            checkpoints directory path.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor={checkpointsDirId}>Checkpoints Dir</Label>
            <Input
              id={checkpointsDirId}
              placeholder="gs://your-bucket-name/path/to/checkpoints"
              value={checkpointsDir}
              onChange={(e) => setCheckpointsDir(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Enter the GCS checkpoint directory path</p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={creating}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !checkpointsDir.trim()}
          >
            {creating ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Creating...
              </>
            ) : (
              'Create App Config'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { useState, useId } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import { Loader2 } from 'lucide-react';

export default function AddEnvironment() {
  const router = useRouter();
  const encodedConfigId = useId();
  const environmentNameId = useId();

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
    setNameError(/\s/.test(value) ? 'Environment name cannot contain whitespaces' : null);
    setError(null);
  };

  const handleAdd = async (overwrite: boolean = false) => {
    if (!encodedConfig.trim()) { setError('Please provide an encoded config'); return; }
    if (!environmentName.trim()) { setError('Please provide an environment name'); return; }
    if (/\s/.test(environmentName)) { setError('Environment name cannot contain whitespaces'); return; }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/add-environment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encodedConfig: encodedConfig.trim(),
          environmentName: environmentName.trim(),
          overwrite,
        }),
      });
      const data = await response.json();
      if (data.success) {
        router.push('/home');
      } else if (data.environmentExists && !overwrite) {
        setPendingEnvironmentName(environmentName.trim());
        setShowOverwriteDialog(true);
      } else {
        setError(data.error || 'Failed to add environment');
      }
    } catch {
      setError('Failed to add environment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={showOverwriteDialog} onOpenChange={(open) => { if (!open) { setShowOverwriteDialog(false); setPendingEnvironmentName(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Environment Already Exists</DialogTitle>
            <DialogDescription>
              The environment <strong>{pendingEnvironmentName}</strong> already exists.
              Do you want to overwrite its kubeconfig file?
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertDescription>
              This will replace the kubeconfig file in the kubeconfigs directory. No changes will be made to app-config.json.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowOverwriteDialog(false); setPendingEnvironmentName(''); }}>
              Cancel
            </Button>
            <Button onClick={async () => { setShowOverwriteDialog(false); await handleAdd(true); }}>
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex min-h-[calc(100vh-100px)] items-center justify-center py-8 px-4">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle className="text-primary">Add an Environment</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={undefined}>
                <FieldLabel htmlFor={encodedConfigId}>Encoded Config</FieldLabel>
                <FieldDescription>Copy your encoded config here (e.g., from 1Password)</FieldDescription>
                <Textarea
                  id={encodedConfigId}
                  rows={8}
                  value={encodedConfig}
                  onChange={(e) => { setEncodedConfig(e.target.value); setError(null); }}
                  placeholder="Paste your base64 encoded kubeconfig here..."
                  className="font-mono text-sm"
                />
              </Field>

              <Field data-invalid={nameError ? true : undefined}>
                <FieldLabel htmlFor={environmentNameId}>Environment Name</FieldLabel>
                <FieldDescription>No whitespaces allowed</FieldDescription>
                <Input
                  id={environmentNameId}
                  value={environmentName}
                  onChange={handleEnvironmentNameChange}
                  aria-invalid={!!nameError}
                />
                {nameError && <FieldError>{nameError}</FieldError>}
              </Field>

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => router.push('/home')}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => handleAdd(false)}
                  disabled={submitting || !!nameError || !encodedConfig.trim() || !environmentName.trim()}
                >
                  {submitting && <Loader2 data-icon="inline-start" className="animate-spin" />}
                  {submitting ? 'Adding...' : 'Add'}
                </Button>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface RotationKeyModalProps {
  open: boolean;
  rotationKey: string;
  onClose: () => void;
}

export function RotationKeyModal({ open, rotationKey, onClose }: RotationKeyModalProps) {
  const [saved, setSaved] = useState(false);

  const copyKey = async () => {
    await navigator.clipboard.writeText(rotationKey);
    toast.success('Rotation key copied to clipboard');
  };

  const handleClose = () => {
    if (!saved) {
      const confirmed = window.confirm(
        'Are you sure? You will never see this rotation key again. Without it, you cannot migrate your community.'
      );
      if (!confirmed) return;
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Save your rotation key</DialogTitle>
          <DialogDescription className="text-destructive font-medium">
            This is the only time you will see this key. It grants full control over your
            community identity. Back it up securely now. OpenFederation and PDS operators
            will NEVER ask you for this key. Any request for it is a phishing attempt.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted p-4">
            <code className="block break-all text-sm font-mono">{rotationKey}</code>
          </div>
          <Button variant="outline" className="w-full" onClick={copyKey}>
            Copy to clipboard
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="rounded"
            />
            I have saved my rotation key
          </label>
        </div>
        <DialogFooter>
          <Button onClick={handleClose} disabled={!saved}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

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

interface DidDocumentModalProps {
  open: boolean;
  didDocument: Record<string, unknown>;
  instructions: string;
  onClose: () => void;
}

export function DidDocumentModal({
  open,
  didDocument,
  instructions,
  onClose,
}: DidDocumentModalProps) {
  const jsonStr = JSON.stringify(didDocument, null, 2);

  const copyJson = async () => {
    await navigator.clipboard.writeText(jsonStr);
    toast.success('DID document copied to clipboard');
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>DID document setup</DialogTitle>
          <DialogDescription>{instructions}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="max-h-80 overflow-auto rounded-md bg-muted p-4">
            <pre className="text-xs font-mono whitespace-pre-wrap">{jsonStr}</pre>
          </div>
          <Button variant="outline" className="w-full" onClick={copyJson}>
            Copy JSON
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

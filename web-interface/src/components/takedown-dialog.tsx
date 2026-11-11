'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAdminTakedownMutation } from '@/hooks/use-admin';
import type { TakedownTier } from '@/lib/api/types';

const TIERS: { value: TakedownTier; title: string; detail: string }[] = [
  {
    value: 'standard',
    title: 'Standard',
    detail: 'Rules broken, nothing illegal. Hidden now; the owner is emailed a private download link and the data is deleted after 30 days.',
  },
  {
    value: 'hard',
    title: 'Hard',
    detail: 'Evident illegal content. Hidden now; the owner cannot download anything; the data is kept unchanged for 90 days, then deleted.',
  },
];

interface TakedownDialogProps {
  target: { did: string; handle: string; kind: 'account' | 'community' } | null;
  onClose: () => void;
}

/** Take an account or community down under docs/FAIR-USE.md: choose the tier and give a reason. */
export function TakedownDialog({ target, onClose }: TakedownDialogProps) {
  const [tier, setTier] = useState<TakedownTier>('standard');
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const mutation = useAdminTakedownMutation();

  const close = () => {
    setTier('standard');
    setReason('');
    setNotify(true);
    onClose();
  };

  const confirm = () => {
    if (!target || !reason.trim()) return;
    mutation.mutate(
      { did: target.did, tier, reason: reason.trim(), notify: tier === 'hard' ? notify : true },
      {
        onSuccess: (r) => {
          toast.success(`Taken down (${r.tier}); data is deleted on ${new Date(r.deleteAfter).toLocaleDateString()}`);
          close();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  if (!target) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) close(); }}
      title={`Take down ${target.kind}`}
      description={`Take down @${target.handle}? It is hidden from everyone at once. The reason is shown to the owner.`}
      confirmLabel={tier === 'hard' ? 'Hard takedown' : 'Take down'}
      variant="destructive"
      loading={mutation.isPending}
      confirmDisabled={!reason.trim()}
      onConfirm={confirm}
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Kind of takedown</legend>
          {TIERS.map((t) => (
            <label
              key={t.value}
              className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${tier === t.value ? 'border-primary bg-muted' : ''}`}
            >
              <input
                type="radio"
                name="takedown-tier"
                value={t.value}
                checked={tier === t.value}
                onChange={() => setTier(t.value)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{t.title}</span>
                <span className="block text-muted-foreground">{t.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="takedown-reason">Reason (required, shown to the owner)</Label>
          <Textarea
            id="takedown-reason"
            placeholder="Which rule was broken, or what was found"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
          />
        </div>

        {tier === 'hard' && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={!notify} onChange={(e) => setNotify(!e.target.checked)} className="mt-1 size-4" />
            <span>
              Don&apos;t notify the owner
              <span className="block text-muted-foreground">Only when an authority has asked that the owner not be told.</span>
            </span>
          </label>
        )}
      </div>
    </ConfirmDialog>
  );
}

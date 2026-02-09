'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { createInvite } from '@/lib/api/admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function InviteCodeForm() {
  const [maxUses, setMaxUses] = useState(1);
  const [expiresIn, setExpiresIn] = useState('7d');
  const [loading, setLoading] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');

  const computeExpiresAt = (): string | undefined => {
    if (expiresIn === 'never') return undefined;

    const now = Date.now();
    const durations: Record<string, number> = {
      '1d': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };

    return new Date(now + durations[expiresIn]).toISOString();
  };

  const handleGenerate = async () => {
    setLoading(true);
    setGeneratedCode('');

    const result = await createInvite(maxUses, computeExpiresAt());
    if (result.ok) {
      setGeneratedCode(result.data.code);
      toast.success('Invite code generated');
    } else {
      toast.error(result.message);
    }
    setLoading(false);
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(generatedCode);
    toast.success('Invite code copied');
  };

  return (
    <div className="space-y-4 max-w-sm">
      <div className="space-y-2">
        <Label htmlFor="maxUses">Max uses</Label>
        <Input
          id="maxUses"
          type="number"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(Math.max(1, parseInt(e.target.value) || 1))}
        />
      </div>

      <div className="space-y-2">
        <Label>Expires in</Label>
        <Select value={expiresIn} onValueChange={setExpiresIn}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1d">1 day</SelectItem>
            <SelectItem value="7d">7 days</SelectItem>
            <SelectItem value="30d">30 days</SelectItem>
            <SelectItem value="never">Never</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button onClick={handleGenerate} disabled={loading}>
        {loading ? 'Generating...' : 'Generate Invite Code'}
      </Button>

      {generatedCode && (
        <div className="rounded-md border bg-muted p-4 space-y-2">
          <code className="block text-sm font-mono font-semibold">{generatedCode}</code>
          <Button variant="outline" size="sm" onClick={copyCode}>
            Copy code
          </Button>
        </div>
      )}
    </div>
  );
}

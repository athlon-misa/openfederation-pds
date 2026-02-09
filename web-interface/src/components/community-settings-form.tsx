'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { updateCommunity } from '@/lib/api/communities';
import type { CommunityDetail } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  community: CommunityDetail;
  onUpdated?: () => void;
}

export function CommunitySettingsForm({ community, onUpdated }: Props) {
  const [displayName, setDisplayName] = useState(community.displayName);
  const [description, setDescription] = useState(community.description);
  const [visibility, setVisibility] = useState(community.visibility);
  const [joinPolicy, setJoinPolicy] = useState(community.joinPolicy);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const result = await updateCommunity(community.did, {
      displayName,
      description,
      visibility,
      joinPolicy,
    });

    setLoading(false);

    if (result.ok) {
      toast.success('Settings updated');
      onUpdated?.();
    } else {
      toast.error(result.message);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      <div className="space-y-2">
        <Label htmlFor="settings-displayName">Display Name</Label>
        <Input
          id="settings-displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-description">Description</Label>
        <Textarea
          id="settings-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <Label>Visibility</Label>
        <Select value={visibility} onValueChange={(v) => setVisibility(v as 'public' | 'private')}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="private">Private</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Private communities are hidden from the explore page.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Join Policy</Label>
        <Select value={joinPolicy} onValueChange={(v) => setJoinPolicy(v as 'open' | 'approval')}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="approval">Requires Approval</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Open communities allow anyone to join instantly.
        </p>
      </div>

      <Button type="submit" disabled={loading}>
        {loading ? 'Saving...' : 'Save Settings'}
      </Button>
    </form>
  );
}

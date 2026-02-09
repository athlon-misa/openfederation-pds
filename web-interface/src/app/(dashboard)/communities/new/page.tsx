'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCommunity } from '@/lib/api/communities';
import type { CommunityCreateResponse } from '@/lib/api/types';
import { isValidHandle } from '@/lib/validators';
import { RotationKeyModal } from '@/components/rotation-key-modal';
import { DidDocumentModal } from '@/components/did-document-modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function NewCommunityPage() {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [didMethod, setDidMethod] = useState<'plc' | 'web'>('plc');
  const [domain, setDomain] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Modal state
  const [plcResult, setPlcResult] = useState<{ key: string } | null>(null);
  const [webResult, setWebResult] = useState<{
    didDocument: Record<string, unknown>;
    instructions: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!isValidHandle(handle)) {
      setError('Handle must be 3-255 characters: lowercase letters, numbers, hyphens.');
      return;
    }

    if (didMethod === 'web' && !domain) {
      setError('Domain is required for did:web.');
      return;
    }

    setLoading(true);
    const result = await createCommunity(handle, didMethod, {
      domain: didMethod === 'web' ? domain : undefined,
      displayName: displayName || undefined,
      description: description || undefined,
    });

    if (!result.ok) {
      setError(result.message);
      setLoading(false);
      return;
    }

    setLoading(false);
    const data: CommunityCreateResponse = result.data;

    if (data.didMethod === 'plc') {
      setPlcResult({ key: data.primaryRotationKey });
    } else {
      setWebResult({
        didDocument: data.didDocument,
        instructions: data.instructions,
      });
    }
  };

  const handleModalClose = () => {
    setPlcResult(null);
    setWebResult(null);
    router.push('/communities');
  };

  return (
    <>
      <div className="max-w-lg mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Create Community</CardTitle>
            <CardDescription>Set up a new OpenFederation community</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="handle">Handle</Label>
                <Input
                  id="handle"
                  placeholder="my-community"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.toLowerCase())}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>DID Method</Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="didMethod"
                      value="plc"
                      checked={didMethod === 'plc'}
                      onChange={() => setDidMethod('plc')}
                    />
                    did:plc (recommended)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="didMethod"
                      value="web"
                      checked={didMethod === 'web'}
                      onChange={() => setDidMethod('web')}
                    />
                    did:web
                  </label>
                </div>
              </div>

              {didMethod === 'web' && (
                <div className="space-y-2">
                  <Label htmlFor="domain">Domain</Label>
                  <Input
                    id="domain"
                    placeholder="community.example.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    You&apos;ll need to host a DID document at this domain.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="displayName">Display Name</Label>
                <Input
                  id="displayName"
                  placeholder="My Community"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="What is this community about?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>
            </CardContent>
            <CardFooter className="flex gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push('/communities')}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Creating...' : 'Create Community'}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>

      {plcResult && (
        <RotationKeyModal
          open
          rotationKey={plcResult.key}
          onClose={handleModalClose}
        />
      )}

      {webResult && (
        <DidDocumentModal
          open
          didDocument={webResult.didDocument}
          instructions={webResult.instructions}
          onClose={handleModalClose}
        />
      )}
    </>
  );
}

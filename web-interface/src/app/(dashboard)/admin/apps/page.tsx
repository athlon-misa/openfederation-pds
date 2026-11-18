'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Copy } from 'lucide-react';
import {
  useOidcClientsQuery, useCreateOidcClientMutation, useOidcClientSetupMutation,
  useRotateOidcClientSecretMutation, useDeleteOidcClientMutation,
} from '@/hooks/use-oidc-clients';
import type { OidcClient, OidcPreset } from '@/lib/api/oidc-clients';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

const PRESETS: Record<OidcPreset, { title: string; text: string }> = {
  mastodon: { title: 'Mastodon', text: 'Mastodon 4.x. You paste the settings into its .env.production.' },
  lemmy: { title: 'Lemmy', text: 'Lemmy 1.0 or later. You enter the settings under Admin, OAuth providers.' },
  gotosocial: { title: 'GoToSocial', text: 'You paste the settings into its config.yaml. Only accounts on this server can sign up there, since GoToSocial needs an email address.' },
  generic: { title: 'Another app', text: 'Any app that supports OpenID Connect. You give the address it returns people to.' },
};

/** Shows a configuration block, and the secret when it is shown for the only time. */
function Configuration({ text, secret }: { text: string; secret?: string }) {
  const copy = (value: string, what: string) => {
    void navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  };
  return (
    <div className="space-y-3">
      {secret && (
        <div className="space-y-1">
          <Label>Client secret</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted px-3 py-2 rounded font-mono text-sm break-all">{secret}</code>
            <Button variant="outline" size="sm" onClick={() => copy(secret, 'Secret')} aria-label="Copy the client secret">
              <Copy className="size-4" />
            </Button>
          </div>
          <p className="text-sm text-destructive font-medium">Save it now: it is not shown again. It is also in the settings below.</p>
        </div>
      )}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label>Settings for the app</Label>
          <Button variant="outline" size="sm" onClick={() => copy(text, 'Settings')}>
            <Copy className="size-4 mr-2" /> Copy
          </Button>
        </div>
        <pre className="bg-muted px-3 py-2 rounded font-mono text-xs whitespace-pre-wrap break-all max-h-72 overflow-auto">{text}</pre>
      </div>
    </div>
  );
}

export default function AdminAppsPage() {
  const { data, isLoading, isFetching, error, refetch } = useOidcClientsQuery();
  const createMutation = useCreateOidcClientMutation();
  const setupMutation = useOidcClientSetupMutation();
  const rotateMutation = useRotateOidcClientSecretMutation();
  const deleteMutation = useDeleteOidcClientMutation();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<OidcPreset>('mastodon');
  const [appUrl, setAppUrl] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [communityDid, setCommunityDid] = useState('');
  const [created, setCreated] = useState<{ configuration: string; secret: string } | null>(null);
  const [shown, setShown] = useState<{ title: string; configuration: string; secret?: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<OidcClient | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OidcClient | null>(null);

  const reset = () => {
    setName(''); setPreset('mastodon'); setAppUrl(''); setRedirectUri(''); setCommunityDid(''); setCreated(null);
  };

  const handleCreate = () => {
    createMutation.mutate(
      {
        name: name.trim(),
        preset,
        ...(preset !== 'generic' ? { appUrl: appUrl.trim() } : { redirectUris: [redirectUri.trim()] }),
        ...(communityDid.trim() ? { communityDid: communityDid.trim() } : {}),
      },
      {
        onSuccess: (res) => {
          setCreated({ configuration: res.configuration ?? '', secret: res.clientSecret });
          toast.success(`${res.client.name} can now sign people in`);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const canCreate = name.trim() && (preset === 'generic' ? redirectUri.trim() : appUrl.trim());

  const columns: ColumnDef<OidcClient, unknown>[] = [
    { accessorKey: 'name', header: 'App' },
    { accessorKey: 'clientId', header: 'Client ID', cell: ({ row }) => <code className="text-xs">{row.original.clientId}</code> },
    { id: 'kind', header: 'Kind', cell: ({ row }) => PRESETS[row.original.preset ?? 'generic']?.title ?? 'Another app' },
    { id: 'who', header: 'Who can sign in', cell: ({ row }) => (row.original.communityDid ? 'Members of one community' : 'Anyone with an AT Protocol account') },
    { accessorKey: 'createdAt', header: 'Added', cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString() },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="outline" disabled={setupMutation.isPending} onClick={() => setupMutation.mutate(row.original.clientId, {
            onSuccess: (res) => setShown({ title: `Settings for ${row.original.name}`, configuration: res.configuration }),
            onError: (e) => toast.error(e.message),
          })}>Settings</Button>
          <Button size="sm" variant="outline" onClick={() => setRotateTarget(row.original)}>New secret</Button>
          <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(row.original)}>Remove</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sign-in for other apps"
        description="Apps such as Mastodon and Lemmy that let people sign in with their account here, or with any AT Protocol account such as Bluesky."
      >
        <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) reset(); }}>
          <DialogTrigger asChild>
            <Button disabled={data ? !data.enabled : true}>
              <Plus className="size-4 mr-2" /> Add an app
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Add an app</DialogTitle>
              <DialogDescription>
                The app sends people here to sign in. It learns their permanent identifier, handle and display name, and, for accounts on this server, their email address. It never gets their password.
              </DialogDescription>
            </DialogHeader>
            {created ? (
              <Configuration text={created.configuration} secret={created.secret} />
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="app-kind">Kind of app</Label>
                  <Select value={preset} onValueChange={(v) => setPreset(v as OidcPreset)}>
                    <SelectTrigger id="app-kind"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(PRESETS) as OidcPreset[]).map((p) => (
                        <SelectItem key={p} value={p}>{PRESETS[p].title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">{PRESETS[preset].text}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="app-name">Name people see when signing in</Label>
                  <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Our Mastodon" />
                </div>
                {preset !== 'generic' ? (
                  <div className="space-y-2">
                    <Label htmlFor="app-url">The app&apos;s address</Label>
                    <Input id="app-url" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://mastodon.example.org" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="app-redirect">Address the app returns people to (redirect URI)</Label>
                    <Input id="app-redirect" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} placeholder="https://app.example.org/oauth/callback" />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="app-community">Only members of one community (optional)</Label>
                  <Input id="app-community" value={communityDid} onChange={(e) => setCommunityDid(e.target.value)} placeholder="did:plc:… of the community" />
                  <p className="text-sm text-muted-foreground">Leave empty to let anyone with an AT Protocol account sign in.</p>
                </div>
              </div>
            )}
            <DialogFooter>
              {created ? (
                <Button onClick={() => { setCreateOpen(false); reset(); }}>I saved the settings</Button>
              ) : (
                <Button onClick={handleCreate} disabled={createMutation.isPending || !canCreate}>
                  {createMutation.isPending ? 'Adding...' : 'Add the app'}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageHeader>

      {data && !data.enabled && (
        <div className="rounded-md border p-4 text-sm">
          Sign-in for other apps is off. Turn it on under <Link className="underline" href="/admin/settings">Server settings</Link>, Sign-in for other apps, then add an app here.
        </div>
      )}
      {data?.enabled && (
        <p className="text-sm text-muted-foreground">
          Issuer: <code>{data.issuer}</code>. See docs/OIDC.md for each app&apos;s setup.
        </p>
      )}

      <DataTable
        columns={columns}
        data={data?.clients ?? []}
        total={data?.clients?.length ?? 0}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        hasData={data !== undefined}
        onRetry={() => { void refetch(); }}
        emptyTitle="No apps yet"
        emptyDescription="Apps you add here can let people sign in with their account on this server or any other AT Protocol server."
      />

      <Dialog open={!!shown} onOpenChange={(open) => { if (!open) setShown(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{shown?.title}</DialogTitle>
            <DialogDescription>{shown?.secret ? 'The new secret is shown only now.' : 'The client secret is not shown again; give the app a new one if it was lost.'}</DialogDescription>
          </DialogHeader>
          {shown && <Configuration text={shown.configuration} secret={shown.secret} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!rotateTarget}
        onOpenChange={(open) => { if (!open) setRotateTarget(null); }}
        title="Give the app a new secret"
        description={`${rotateTarget?.name} stops signing people in until its settings have the new secret. People already signed in to it stay signed in.`}
        confirmLabel="New secret"
        loading={rotateMutation.isPending}
        onConfirm={() => {
          if (!rotateTarget) return;
          rotateMutation.mutate(rotateTarget.clientId, {
            onSuccess: (res) => {
              setShown({ title: `New secret for ${rotateTarget.name}`, configuration: res.configuration ?? '', secret: res.clientSecret });
              setRotateTarget(null);
            },
            onError: (e) => toast.error(e.message),
          });
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Remove the app"
        description={`${deleteTarget?.name} can no longer sign anyone in through this server. Accounts people made there stay in the app. To undo, add the app again and give it the new settings.`}
        confirmLabel="Remove"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteMutation.mutate(deleteTarget.clientId, {
            onSuccess: () => { toast.success(`${deleteTarget.name} removed`); setDeleteTarget(null); },
            onError: (e) => toast.error(e.message),
          });
        }}
      />
    </div>
  );
}

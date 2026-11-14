'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Note, StatusMessage } from '@/components/account/explain';
import { downloadBackup, listFiles, publishClaim, type PenSession, type RepoFile } from '@/lib/pen-names/pen-names';
import { fileSafe, saveFile } from './pen-parts';

/** Folders of a repository, by what they hold. */
const FOLDERS: Record<string, { name: string; what: string }> = {
  'app.bsky.actor.profile': { name: 'Profile', what: 'The public profile: name, description, picture.' },
  'net.openfederation.authorship.claim': { name: 'Authorship claims', what: 'The fingerprint of a published text, with its title and link. If the text is changed, the fingerprint stops matching.' },
  'net.openfederation.pseudonym.link': { name: 'Proofs', what: 'A public proof linking this pen name to its owner.' },
};

/** Publish an authorship claim as the pen name: only the text's fingerprint, title and link go to the server. */
export function PublishClaim({ session }: { session: PenSession }) {
  const client = useQueryClient();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const urlOk = !url.trim() || /^https?:\/\/\S+$/.test(url.trim());

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMessage(null);
    try {
      const out = await publishClaim({ title: title.trim(), url: url.trim() || undefined, text });
      setMessage({ ok: true, text: `Published as ${session.handle}. Fingerprint ${out.contentHash.slice(0, 16)}…, kept in its files.` });
      setTitle(''); setUrl(''); setText('');
      await client.invalidateQueries({ queryKey: ['pen-files', session.did] });
    } catch (err) {
      const msg = (err as Error).message;
      setMessage({ ok: false, text: /ProbationLimit/.test(msg)
        ? 'A new pen name can only publish a few times a day during its first week. Try again tomorrow.'
        : msg });
    } finally { setBusy(false); }
  }

  return (
    <form className="space-y-3" onSubmit={publish}>
      <p className="text-sm text-muted-foreground">
        Claim authorship of something you published elsewhere. The text stays on this device: only its fingerprint, the title and the link are kept in the pen name&apos;s public files, so anyone can later check that this pen name claimed exactly this text.
      </p>
      <div className="space-y-2">
        <Label htmlFor="claim-title">Title</Label>
        <Input id="claim-title" maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="claim-url">Where it is published (optional)</Label>
        <Input id="claim-url" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!urlOk} />
        {!urlOk && <p className="text-xs text-destructive">Start the link with https:// or http://.</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="claim-text">The text (used for the fingerprint only, never sent)</Label>
        <Textarea id="claim-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <Button type="submit" disabled={busy || !text.trim() || !urlOk}>{busy ? 'Publishing…' : `Publish as ${session.handle}`}</Button>
      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </form>
  );
}

function FileRow({ file }: { file: RepoFile }) {
  const { $type: _type, ...rest } = file.value;
  void _type;
  return (
    <li>
      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 font-mono text-xs">{file.rkey}.json</summary>
        <pre className="max-h-64 overflow-auto border-t bg-muted/40 p-3 text-xs">{JSON.stringify(rest, null, 2)}</pre>
      </details>
    </li>
  );
}

/** The pen name's files, as anyone can read them, and a backup of all of them. */
export function PenFiles({ session }: { session: PenSession }) {
  const files = useQuery({ queryKey: ['pen-files', session.did, session.home.url], queryFn: () => listFiles(session.home.url, session.did) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const byCollection = new Map<string, RepoFile[]>();
  for (const f of files.data ?? []) byCollection.set(f.collection, [...(byCollection.get(f.collection) ?? []), f]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Everything in {session.handle}&apos;s files is public: anyone can read it, as this list does, without signing in.</p>
      {files.isLoading && <Skeleton className="h-24" />}
      {files.error && <StatusMessage ok={false} text={(files.error as Error).message} />}
      {files.data && files.data.length === 0 && <Note>No files yet.</Note>}
      {[...byCollection].map(([collection, list]) => (
        <div key={collection} className="space-y-2">
          <h3 className="text-sm font-semibold">{FOLDERS[collection]?.name ?? collection} <span className="font-normal text-muted-foreground">({list.length})</span></h3>
          {FOLDERS[collection] && <p className="text-xs text-muted-foreground">{FOLDERS[collection].what}</p>}
          <ul className="space-y-1">{list.map((f) => <FileRow key={`${f.collection}/${f.rkey}`} file={f} />)}</ul>
        </div>
      ))}
      <div className="space-y-2 border-t pt-4">
        <Button type="button" variant="outline" disabled={busy} onClick={async () => {
          setBusy(true); setMessage(null);
          try {
            const blob = await downloadBackup(session.home.url, session.did);
            saveFile(blob, `${fileSafe(session.handle)}-backup.car`);
            setMessage({ ok: true, text: `Saved ${fileSafe(session.handle)}-backup.car (${(blob.size / 1024).toFixed(1)} KB). Every file is inside, each one signed.` });
          } catch (e) { setMessage({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
        }}><Download className="size-4" aria-hidden />{busy ? 'Downloading…' : 'Download a backup'}</Button>
        <p className="text-xs text-muted-foreground">One file with all of the pen name&apos;s files, signed, in the standard format any AT Protocol server can import. Keep it somewhere private: saved next to your own files, it links you to the pen name.</p>
        {message && <StatusMessage ok={message.ok} text={message.text} />}
      </div>
    </div>
  );
}

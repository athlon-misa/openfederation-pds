'use client';

import { useMemo, useState } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Acknowledge, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useServerSettingsQuery, useUpdateServerSettingsMutation } from '@/hooks/use-server-settings';
import type { ServerSetting, SettingId, SettingValue } from '@/lib/api/server-settings';
import {
  CONFIRM_ACK, CUSTODY, CUSTODY_ORDER, EMAIL_POLICY, GROUPS, GROUP_ORDER, MOVE_POLICY, SETTING_HINT, SETTING_LABEL,
  effectsOnPeople, fallbackText, formatValue, sourceText, type GroupId,
} from '@/lib/copy/server-settings';

type Values = Partial<Record<SettingId, SettingValue>>;
type Changes = Partial<Record<SettingId, SettingValue | null>>;

const NUMBER_LIMITS: Partial<Record<SettingId, [number, number]>> = {
  pseudonymTokensPerEpoch: [1, 1000],
  pseudonymProbationDays: [0, 365],
  pseudonymProbationDailyWrites: [1, 100000],
};

function same(a: SettingValue | undefined, b: SettingValue | undefined) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Admin, Server settings (#410): the setup wizard's choices, changeable without a restart. */
export default function ServerSettingsPage() {
  const roles = useAuthStore((s) => s.roles);
  const isAdmin = roles.includes('admin');
  const query = useServerSettingsQuery();

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Server settings" />
        <Note>Only admins can see and change the server settings.</Note>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Server settings"
        description="The choices made during setup, changeable at any time without restarting the server."
      />
      <Note>
        A change applies to this server straight away
        {query.data ? ` and reaches every copy of it within ${query.data.refreshSeconds} seconds` : ''}. Every change is
        recorded in the audit log with who made it and the value before and after. A setting marked
        &ldquo;Set by the server&apos;s environment&rdquo; is fixed where the server is hosted and can only be changed there.
      </Note>
      {query.data?.problem && (
        <StatusMessage
          ok={false}
          text={`Some changes made here are not in effect, because they conflict with the server's environment: ${query.data.problem}. The values below are the ones in effect. Change the conflicting setting here, or the environment variable, to resolve it.`}
        />
      )}
      {query.isLoading && <div className="space-y-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 w-full" />)}</div>}
      {query.error && <StatusMessage ok={false} text={`The settings could not be loaded: ${query.error.message}`} />}
      {query.data && GROUP_ORDER.map((group) => (
        <SettingsGroup
          key={group}
          group={group}
          settings={query.data!.settings}
          profile={query.data!.profile}
        />
      ))}
    </div>
  );
}

function SettingsGroup({ group, settings, profile }: { group: GroupId; settings: ServerSetting[]; profile?: string }) {
  const text = GROUPS[group];
  const mine = useMemo(() => text.settings.map((id) => settings.find((s) => s.id === id)).filter((s): s is ServerSetting => !!s), [settings, text.settings]);
  const current = useMemo(() => Object.fromEntries(mine.map((s) => [s.id, s.value])) as Values, [mine]);
  // Only what the admin has edited; everything else follows the server.
  const [edits, setEdits] = useState<Values>({});
  const draft: Values = { ...current, ...edits };
  const [pending, setPending] = useState<{ changes: Changes; notes: string[] } | null>(null);
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const mutation = useUpdateServerSettingsMutation();

  const dirty = mine.filter((s) => !s.fixed && !same(draft[s.id], current[s.id]));
  const set = (id: SettingId, value: SettingValue) => { setResult(null); setEdits((d) => ({ ...d, [id]: value })); };

  function localProblem(): string | null {
    for (const [id, [min, max]] of Object.entries(NUMBER_LIMITS) as [SettingId, [number, number]][]) {
      if (!(id in draft)) continue;
      const n = draft[id];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return `${SETTING_LABEL[id]} must be a whole number from ${min} to ${max}.`;
    }
    if ('custodyAllowed' in draft) {
      const allowed = draft.custodyAllowed as string[];
      if (allowed.length === 0) return 'Offer at least one way to look after accounts.';
      if (!allowed.includes(String(draft.custodyDefault))) return 'The way offered first must be one of the ways offered.';
    }
    return null;
  }

  function request(changes: Changes) {
    const after: Values = {};
    for (const [id, v] of Object.entries(changes) as [SettingId, SettingValue | null][]) {
      after[id] = v === null ? mine.find((s) => s.id === id)!.fallback : v;
    }
    const notes = effectsOnPeople(current, after);
    if (notes.length > 0) {
      setAck(false);
      setPending({ changes, notes });
    } else {
      void save(changes);
    }
  }

  async function save(changes: Changes) {
    setResult(null);
    try {
      const res = await mutation.mutateAsync(changes);
      setEdits({});
      const changed = res.changed.filter((c) => !same(c.before, c.after));
      setResult({ ok: true, text: changed.length ? `Saved: ${changed.map((c) => `${SETTING_LABEL[c.id]} is now ${formatValue(c.id, c.after)}`).join('; ')}.` : 'Saved.' });
    } catch (e) {
      setResult({ ok: false, text: `Nothing was changed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setPending(null);
    }
  }

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    const problem = localProblem();
    if (problem) { setResult({ ok: false, text: problem }); return; }
    request(Object.fromEntries(dirty.map((s) => [s.id, draft[s.id]!])) as Changes);
  }

  return (
    <Section id={`settings-${group}`} title={text.title} description={text.summary}>
      <dl className="space-y-3 text-sm">
        {[
          { label: 'What it means', text: text.means },
          { label: 'What changes for people already here', text: text.alreadyHere },
          { label: 'How to undo it', text: text.undo },
        ].map((row) => (
          <div key={row.label} className="sm:grid sm:grid-cols-[13rem_1fr] sm:gap-4">
            <dt className="font-medium">{row.label}</dt>
            <dd className="mt-0.5 text-muted-foreground sm:mt-0">{row.text}</dd>
          </div>
        ))}
      </dl>
      {text.terms.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1">{text.terms.map((t) => <WhatIsThis key={t} term={t} />)}</div>
      )}

      <form onSubmit={onSave} className="space-y-5 border-t pt-4" aria-label={text.title}>
        {mine.map((s) => (
          <SettingField key={s.id} setting={s} value={draft[s.id]} onChange={(v) => set(s.id, v)} profile={profile}
            onReset={() => request({ [s.id]: null })} busy={mutation.isPending} draft={draft} />
        ))}
        {result && <StatusMessage ok={result.ok} text={result.text} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={dirty.length === 0 || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          {dirty.length > 0 && (
            <Button type="button" variant="outline" onClick={() => { setEdits({}); setResult(null); }} disabled={mutation.isPending}>
              Discard changes
            </Button>
          )}
        </div>
      </form>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title="This changes things for people on this server"
        description="Check what happens before you save."
        confirmLabel="Save the change"
        variant="destructive"
        loading={mutation.isPending}
        confirmDisabled={!ack}
        onConfirm={() => pending && void save(pending.changes)}
      >
        <ul className="list-disc space-y-2 pl-5 text-sm">
          {pending?.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
        <p className="text-sm text-muted-foreground">You can change it back here at any time.</p>
        <Acknowledge id={`ack-${group}`} text={CONFIRM_ACK} checked={ack} onChange={setAck} />
      </ConfirmDialog>
    </Section>
  );
}

/** One address per line, kept as typed; the list sent is the non-empty lines. */
function PeersText({ id, initial, disabled, describedBy, onChange }: {
  id: string;
  initial: string[];
  disabled: boolean;
  describedBy?: string;
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState(initial.join('\n'));
  return (
    <Textarea id={id} rows={4} disabled={disabled} aria-describedby={describedBy}
      value={text} placeholder="https://pds.example.org" spellCheck={false} autoCapitalize="off" autoCorrect="off"
      onChange={(e) => { setText(e.target.value); onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean)); }}
      className="font-mono text-xs" />
  );
}

function SettingField({ setting, value, onChange, onReset, profile, busy, draft }: {
  setting: ServerSetting;
  value: SettingValue | undefined;
  onChange: (v: SettingValue) => void;
  onReset: () => void;
  profile?: string;
  busy: boolean;
  draft: Values;
}) {
  const id = `setting-${setting.id}`;
  const hintId = `${id}-hint`;
  const label = SETTING_LABEL[setting.id];
  const hint = SETTING_HINT[setting.id];
  const disabled = setting.fixed || busy;

  const source = (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        {setting.fixed && <Lock className="size-3.5" aria-hidden />}
        {sourceText(setting, profile)}
      </span>
      {setting.source === 'admin' && !setting.fixed && (
        <button type="button" onClick={onReset} disabled={busy}
          className="inline-flex items-center gap-1 rounded-sm underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">
          <RotateCcw className="size-3" aria-hidden />{fallbackText(setting)}
        </button>
      )}
    </div>
  );

  const hintEl = hint ? <p id={hintId} className="text-sm text-muted-foreground">{hint}</p> : null;

  if (typeof setting.value === 'boolean') {
    return (
      <div>
        <div className="flex items-start gap-3">
          <input id={id} type="checkbox" className="mt-1 size-4 shrink-0 accent-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            checked={value === true} disabled={disabled} aria-describedby={hint ? hintId : undefined}
            onChange={(e) => onChange(e.target.checked)} />
          <div className="space-y-0.5">
            <label htmlFor={id} className="font-medium">{label}</label>
            {hintEl}
          </div>
        </div>
        <div className="pl-7">{source}</div>
      </div>
    );
  }

  if (setting.id === 'custodyAllowed') {
    const list = (value as string[]) ?? [];
    return (
      <fieldset disabled={disabled}>
        <legend className="font-medium">{label}</legend>
        <div className="mt-2 space-y-2">
          {CUSTODY_ORDER.map((m) => (
            <div key={m} className="flex items-start gap-3">
              <input id={`${id}-${m}`} type="checkbox" className="mt-1 size-4 shrink-0 accent-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                checked={list.includes(m)}
                onChange={(e) => onChange(CUSTODY_ORDER.filter((x) => (x === m ? e.target.checked : list.includes(x))))} />
              <label htmlFor={`${id}-${m}`} className="text-sm">
                <span className="font-medium">{CUSTODY[m].title}</span>
                <span className="text-muted-foreground"> · {CUSTODY[m].short}</span>
              </label>
            </div>
          ))}
        </div>
        {source}
      </fieldset>
    );
  }

  if (setting.id === 'custodyDefault') {
    const offered = ((draft.custodyAllowed as string[]) ?? CUSTODY_ORDER);
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="font-medium">{label}</label>
        {hintEl}
        <select id={id} value={String(value)} disabled={disabled} aria-describedby={hint ? hintId : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="block h-9 w-full max-w-xs rounded-md border bg-transparent px-3 text-sm shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">
          {CUSTODY_ORDER.map((m) => (
            <option key={m} value={m} disabled={!offered.includes(m)}>{CUSTODY[m].title}{offered.includes(m) ? '' : ' (not offered)'}</option>
          ))}
        </select>
        {source}
      </div>
    );
  }

  if (setting.id === 'emailVerificationPolicy' || setting.id.startsWith('migration')) {
    const options = setting.id === 'emailVerificationPolicy'
      ? Object.entries(EMAIL_POLICY).map(([v, t]) => ({ v, title: t.title, text: t.text }))
      : (setting.id === 'migrationPseudonyms' ? ['open', 'token', 'closed'] : ['open', 'invite', 'closed'])
        .map((v) => ({ v, title: MOVE_POLICY[v].title, text: '' }));
    return (
      <fieldset disabled={disabled}>
        <legend className="font-medium">{label}</legend>
        {hintEl}
        <div className="mt-2 space-y-2">
          {options.map((o) => (
            <div key={o.v} className="flex items-start gap-3">
              <input id={`${id}-${o.v}`} type="radio" name={id} value={o.v} checked={value === o.v}
                className="mt-1 size-4 shrink-0 accent-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onChange={() => onChange(o.v)} />
              <label htmlFor={`${id}-${o.v}`} className="text-sm">
                <span className="font-medium">{o.title}</span>
                {o.text && <span className="block text-muted-foreground">{o.text}</span>}
              </label>
            </div>
          ))}
        </div>
        {source}
      </fieldset>
    );
  }

  if (setting.id === 'federationPeers') {
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="font-medium">{label}</label>
        {hintEl}
        {/* Keyed by the saved list, so the text follows the server after a save. */}
        <PeersText key={JSON.stringify(setting.value)} id={id} initial={(value as string[]) ?? []} disabled={disabled}
          describedBy={hint ? hintId : undefined} onChange={onChange} />
        {source}
      </div>
    );
  }

  // Whole numbers.
  const [min, max] = NUMBER_LIMITS[setting.id] ?? [0, 100000];
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="font-medium">{label}</label>
      {hintEl}
      <Input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} className="max-w-32"
        value={typeof value === 'number' && Number.isFinite(value) ? value : ''} disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} />
      {source}
    </div>
  );
}

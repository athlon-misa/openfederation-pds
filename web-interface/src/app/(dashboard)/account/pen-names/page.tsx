'use client';

import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { ChoiceExplainer, Note, Section, WhatIsThis } from '@/components/account/explain';
import { identityPolicy } from '@/lib/custody/custody';
import { PEN_NAMES } from '@/lib/copy/glossary';
import { THIS_PDS } from '@/hooks/use-identity';

export default function PenNamesPage() {
  const policy = useQuery({ queryKey: ['identity-policy'], queryFn: () => identityPolicy(THIS_PDS) });
  const enabled = policy.data?.pseudonymsEnabled;
  return (
    <div className="space-y-6">
      <PageHeader title="Pen names" description="Publishing under another name, without your name on it." />
      <Section title="What a pen name is" description={<WhatIsThis term="pen-name" />}>
        <ChoiceExplainer text={PEN_NAMES} />
      </Section>
      <Section title="On this server">
        <p className="text-sm font-medium">
          {policy.isLoading ? 'Checking…' : enabled === undefined ? 'This server did not say whether it allows pen names.'
            : enabled ? 'This server allows new pen names.' : 'This server does not allow new pen names. Pen names that already exist here keep working.'}
        </p>
        <Note>{PEN_NAMES.where}</Note>
        <p className="text-sm text-muted-foreground">
          Someone showed you a proof that a pen name belongs to a person? Open the link they gave you: it checks the proof on your own device, against the public directory, without signing in.
        </p>
      </Section>
    </div>
  );
}

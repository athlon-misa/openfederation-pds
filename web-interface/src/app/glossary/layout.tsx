import type { Metadata } from 'next';
import { GlossaryShell } from '@/components/shell/glossary-shell';

export const metadata: Metadata = {
  title: 'Glossary · OpenFederation',
  description: 'The words used for your identity, its keys, recovery, devices, pen names and moving.',
};

export default function GlossaryLayout({ children }: { children: React.ReactNode }) {
  return <GlossaryShell>{children}</GlossaryShell>;
}

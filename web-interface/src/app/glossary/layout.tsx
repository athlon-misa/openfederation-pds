import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Glossary · OpenFederation',
  description: 'The words used for your identity, its keys, recovery, devices, pen names and moving.',
};

export default function GlossaryLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background">{children}</div>;
}

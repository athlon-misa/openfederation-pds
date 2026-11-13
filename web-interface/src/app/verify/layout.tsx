import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Verify · OpenFederation',
  description: 'Check a pseudonym proof yourself, against the public directory.',
  // The proof travels in the link's #fragment; never send it on as a referrer.
  referrer: 'no-referrer',
};

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen justify-center px-4 py-8 sm:items-center">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

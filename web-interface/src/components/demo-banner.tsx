'use client';

import { useEffect, useState } from 'react';
import { THIS_PDS } from '@/lib/this-pds';
import { demoBannerText, readDemoInfo, type DemoInfo } from '@/lib/demo';

async function fetchDemoInfo(): Promise<DemoInfo | null> {
  const res = await fetch(`${THIS_PDS.replace(/\/+$/, '')}/xrpc/net.openfederation.server.getPublicConfig`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return readDemoInfo(await res.json());
}

/** A strip across the top of every page on a demo server; nothing anywhere else. */
export function DemoBanner({ loadDemoInfo = fetchDemoInfo }: {
  /** For tests: where the demo flag comes from. */
  loadDemoInfo?: () => Promise<DemoInfo | null>;
}) {
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadDemoInfo().then((info) => { if (!cancelled) setDemo(info); }).catch(() => { /* Offline or an older server: no banner. */ });
    return () => { cancelled = true; };
  }, [loadDemoInfo]);
  if (!demo) return null;
  return (
    <div role="status" data-demo-banner=""
      className="border-b border-amber-600/40 bg-amber-50 px-4 py-1.5 text-center text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      {demoBannerText(demo)}
    </div>
  );
}

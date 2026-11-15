/**
 * A demo server (DEMO_MODE on the PDS, docs/DEMO-SERVERS.md) deletes
 * everything on a schedule and says so in getPublicConfig.demo. The dashboard
 * tells everyone, on every page.
 */
export interface DemoInfo {
  enabled: boolean;
  resetSchedule?: string;
  nextResetAt?: string;
}

/** The demo flag from a getPublicConfig body; null when this is not a demo server. */
export function readDemoInfo(body: unknown): DemoInfo | null {
  const demo = (body as { demo?: unknown } | null)?.demo as DemoInfo | undefined;
  if (!demo || demo.enabled !== true) return null;
  return {
    enabled: true,
    resetSchedule: typeof demo.resetSchedule === 'string' ? demo.resetSchedule : undefined,
    nextResetAt: typeof demo.nextResetAt === 'string' ? demo.nextResetAt : undefined,
  };
}

/** "Demo server — everything is deleted every night at 03:00 UTC." */
export function demoBannerText(demo: DemoInfo): string {
  const at = demo.nextResetAt ? new Date(demo.nextResetAt) : null;
  if (!at || Number.isNaN(at.getTime())) return 'Demo server — everything on it is deleted regularly.';
  const hhmm = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  return `Demo server — everything is deleted every night at ${hhmm} UTC.`;
}

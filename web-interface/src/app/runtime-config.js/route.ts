import { runtimeConfigScript } from '@/lib/runtime-config';

// Rendered per request from the dashboard server's environment, so one image
// serves any PDS (#405). See src/lib/runtime-config.ts.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(runtimeConfigScript(process.env), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      // Changes only when the container restarts with a new PDS_URL; a few
      // minutes of caching saves a request on every full page load.
      'Cache-Control': 'public, max-age=300',
    },
  });
}

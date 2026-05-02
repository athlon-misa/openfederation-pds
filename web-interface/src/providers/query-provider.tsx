'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 60s default keeps tab-switches snappy without showing stale
            // data for long. Hooks that touch slow-moving data (server
            // config, peer communities) override with longer windows.
            // refetchOnWindowFocus: true respects staleTime — focus only
            // triggers a refetch when the data is actually stale.
            staleTime: 60 * 1000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

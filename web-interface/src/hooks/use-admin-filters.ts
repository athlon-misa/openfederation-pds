'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseAdminFilters, updateAdminQuery, type AdminFilters } from '@/lib/admin-filters';

function update(change: Partial<AdminFilters>) {
  const next = updateAdminQuery(new URLSearchParams(window.location.search), change).toString();
  // Next's native history integration updates useSearchParams without a server navigation.
  window.history.replaceState(null, '', `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`);
}

export function useAdminFilters() {
  const params = useSearchParams();
  const query = params.toString();
  const filters = parseAdminFilters(new URLSearchParams(query));
  const [draft, setDraft] = useState<{ query: string; value: string } | null>(null);
  // Permanently discard an abandoned draft, even if Back returns to its old URL.
  // React allows this guarded adjustment of this component's own render state.
  if (draft && draft.query !== query) setDraft(null);
  const search = draft?.query === query ? draft.value : filters.search;
  useEffect(() => {
    if (search === filters.search) return;
    const timer = window.setTimeout(() => update({ search }), 300);
    return () => window.clearTimeout(timer);
  }, [search, filters.search, query]);

  return {
    ...filters,
    search,
    querySearch: filters.search,
    setSearch: (value: string) => setDraft({ query, value }),
    setStatus: (status: string) => update({ status, search }),
    setRole: (role: string) => update({ role, search }),
    setPage: (page: number) => update(search !== filters.search ? { search } : { page }),
    clear: () => { setDraft(null); update({ search: '', role: '', status: '' }); },
  };
}

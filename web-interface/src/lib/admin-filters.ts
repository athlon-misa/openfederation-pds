export const ACCOUNT_STATUSES = ['pending', 'approved', 'rejected', 'suspended', 'takendown', 'deactivated', 'disabled'] as const;
export const ACCOUNT_ROLES = ['admin', 'moderator', 'partner-manager', 'auditor', 'user'] as const;
export interface AdminFilters { status: string; role: string; search: string; page: number }

export function parseAdminFilters(params: URLSearchParams): AdminFilters {
  const rawPage = params.get('page') ?? '1';
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : 0;
  return {
    status: ACCOUNT_STATUSES.find((s) => s === params.get('status')) ?? '',
    role: ACCOUNT_ROLES.find((r) => r === params.get('role')) ?? '',
    search: params.get('q') ?? '',
    page: Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page - 1 : 0,
  };
}

export function updateAdminQuery(params: URLSearchParams, change: Partial<AdminFilters>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(change)) {
    if (key === 'page') continue;
    const queryKey = key === 'search' ? 'q' : key;
    if (value) next.set(queryKey, String(value)); else next.delete(queryKey);
  }
  if ('search' in change || 'status' in change || 'role' in change) next.delete('page');
  else if (change.page !== undefined) {
    if (change.page > 0) next.set('page', String(change.page + 1)); else next.delete('page');
  }
  return next;
}

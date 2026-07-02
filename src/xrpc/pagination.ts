/**
 * Shared limit/cursor parsing for XRPC list endpoints.
 *
 * Semantics match the long-standing inline pattern:
 *   Math.min(Math.max(parseInt(String(query.limit || DEF), 10) || DEF, 1), MAX)
 * so `limit=0`, missing, and unparsable values all fall back to the default.
 */
export interface PaginationParams {
  limit: number;
  cursor?: string;
}

export function parsePagination(
  query: Record<string, unknown>,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): PaginationParams {
  const { defaultLimit = 50, maxLimit = 100 } = opts;
  const limit = Math.min(
    Math.max(parseInt(String(query.limit || defaultLimit), 10) || defaultLimit, 1),
    maxLimit,
  );
  const cursor = typeof query.cursor === 'string' && query.cursor.length > 0
    ? query.cursor
    : undefined;
  return { limit, cursor };
}

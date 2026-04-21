import type { ApiResult } from './types';

/**
 * Unwraps an ApiResult into its data value, or throws an Error with the
 * server-provided message. Use inside React Query `queryFn` / `mutationFn`
 * so the default error handling picks up `error.message`.
 */
export function unwrapApi<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

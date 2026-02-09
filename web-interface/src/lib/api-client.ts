import type { ApiResult } from './api/types';

const PDS_URL = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';

let tokenGetter: (() => string | null) | null = null;

export function setTokenGetter(getter: () => string | null) {
  tokenGetter = getter;
}

interface XrpcOptions {
  method?: 'GET' | 'POST';
  params?: Record<string, string | number>;
  body?: unknown;
  noAuth?: boolean;
}

export async function xrpc<T>(nsid: string, options: XrpcOptions = {}): Promise<ApiResult<T>> {
  const { method = 'POST', params, body, noAuth = false } = options;

  let url = `${PDS_URL}/xrpc/${nsid}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, String(value));
    }
    url += `?${searchParams.toString()}`;
  }

  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (!noAuth && tokenGetter) {
    const token = tokenGetter();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: data.error || 'UnknownError',
        message: data.message || 'An unknown error occurred',
      };
    }

    return { ok: true, data: data as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'NetworkError',
      message: err instanceof Error ? err.message : 'Network request failed',
    };
  }
}

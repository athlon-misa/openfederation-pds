import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setTokenGetter } from '@/lib/api-client';
import { createSession, refreshSession, getSession, resolveExternal, completeExternalLogin, deleteSession } from '@/lib/api/auth';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  did: string | null;
  handle: string | null;
  email: string | null;
  roles: string[];
  status: string | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isModerator: boolean;
  isPartnerManager: boolean;
  isAuditor: boolean;
  hasAdminAccess: boolean;
  isHydrated: boolean;

  login: (identifier: string, password: string) => Promise<{ ok: true } | { ok: false; error: string; message: string }>;
  externalLogin: (handle: string) => Promise<{ ok: true; redirectUrl: string } | { ok: false; error: string; message: string }>;
  handleCallback: (code: string) => Promise<{ ok: true } | { ok: false; error: string; message: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  hydrate: () => Promise<void>;
}

type SessionState = {
  roles: string[];
  status: string | null;
  isAdmin: boolean;
  isModerator: boolean;
  isPartnerManager: boolean;
  isAuditor: boolean;
  hasAdminAccess: boolean;
};

const ADMIN_ACCESS_ROLES = new Set(['admin', 'moderator', 'partner-manager', 'auditor']);

const loggedOutState = {
  accessToken: null,
  refreshToken: null,
  did: null,
  handle: null,
  email: null,
  roles: [],
  status: null,
  isAuthenticated: false,
  isAdmin: false,
  isModerator: false,
  isPartnerManager: false,
  isAuditor: false,
  hasAdminAccess: false,
};

function deriveSessionState(roles: string[], status: string | null): SessionState {
  return {
    roles,
    status,
    isAdmin: roles.includes('admin'),
    isModerator: roles.includes('moderator'),
    isPartnerManager: roles.includes('partner-manager'),
    isAuditor: roles.includes('auditor'),
    hasAdminAccess: roles.some((r) => ADMIN_ACCESS_ROLES.has(r)),
  };
}

/**
 * Returns session-state flags derived from login/refresh/callback responses.
 * If the server included `roles` in the response, uses those directly
 * (optimization: skip the extra getSession round-trip). Otherwise falls back
 * to calling getSession. Returns null if neither source has usable data.
 */
async function resolveSessionState(
  responseRoles: string[] | undefined,
  responseStatus: string | undefined,
): Promise<SessionState | null> {
  if (responseRoles) {
    return deriveSessionState(responseRoles, responseStatus ?? 'approved');
  }
  const sessionResult = await getSession();
  if (!sessionResult.ok) return null;
  return deriveSessionState(sessionResult.data.roles, sessionResult.data.status);
}

const PERSIST_KEY = 'openfed-auth';

/** The refresh token as last persisted by any tab, or null if there is none to read. */
function readPersistedRefreshToken(): string | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PERSIST_KEY) : null;
    if (!raw) return null;
    const token = (JSON.parse(raw) as { state?: { refreshToken?: unknown } }).state?.refreshToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** One refresh at a time across tabs, where the browser offers a cross-tab lock. */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request('openfed-auth-refresh', fn) as Promise<T>) : fn();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => {
      // Wire up the token getter for the API client
      setTokenGetter(() => get().accessToken);

      return {
        accessToken: null,
        refreshToken: null,
        did: null,
        handle: null,
        email: null,
        roles: [],
        status: null,
        isAuthenticated: false,
        isAdmin: false,
        isModerator: false,
        isPartnerManager: false,
        isAuditor: false,
        hasAdminAccess: false,
        isHydrated: false,

        login: async (identifier, password) => {
          const result = await createSession(identifier, password);
          if (!result.ok) {
            return { ok: false, error: result.error, message: result.message };
          }

          set({
            accessToken: result.data.accessJwt,
            refreshToken: result.data.refreshJwt,
            did: result.data.did,
            handle: result.data.handle,
            email: result.data.email,
            isAuthenticated: true,
          });

          const sessionState = await resolveSessionState(result.data.roles, result.data.status);
          if (sessionState) set(sessionState);

          return { ok: true };
        },

        externalLogin: async (handle) => {
          const result = await resolveExternal(handle);
          if (!result.ok) {
            return { ok: false, error: result.error, message: result.message };
          }
          return { ok: true, redirectUrl: result.data.redirectUrl };
        },

        handleCallback: async (code) => {
          const result = await completeExternalLogin(code);
          if (!result.ok) {
            return { ok: false, error: result.error, message: result.message };
          }

          set({
            accessToken: result.data.accessJwt,
            refreshToken: result.data.refreshJwt,
            did: result.data.did,
            handle: result.data.handle,
            email: result.data.email,
            isAuthenticated: true,
          });

          const sessionState = await resolveSessionState(result.data.roles, result.data.status);
          if (sessionState) set(sessionState);

          return { ok: true };
        },

        logout: async () => {
          const refreshJwt = get().refreshToken;
          try {
            if (refreshJwt) await deleteSession(refreshJwt);
          } finally {
            set(loggedOutState);
          }
        },

        refresh: async () => withRefreshLock(async () => {
          // Tabs share the persisted refresh token but each keeps its own copy
          // in memory. The server rotates the token on use, so a tab that
          // refreshes with its stale copy is presenting a token that has
          // already been rotated away. Take the persisted one, which is
          // whatever the most recent refresh in any tab wrote.
          const refreshToken = readPersistedRefreshToken() ?? get().refreshToken;
          if (!refreshToken) return false;

          const result = await refreshSession(refreshToken);
          if (!result.ok) {
            // Only a refusal of the token ends the session. A network error,
            // a rate limit or a server error says nothing about the token;
            // logging out on those turned a blip into a sign-out everywhere
            // (logout also deletes the session on the server).
            if (result.status === 400 || result.status === 401 || result.status === 403 || result.status === 410) {
              await get().logout();
            }
            return false;
          }

          set({
            accessToken: result.data.accessJwt,
            refreshToken: result.data.refreshJwt,
            did: result.data.did,
            handle: result.data.handle,
            email: result.data.email,
            isAuthenticated: true,
          });

          const sessionState = await resolveSessionState(result.data.roles, result.data.status);
          if (sessionState) set(sessionState);

          return true;
        }),

        hydrate: async () => {
          const { refreshToken } = get();
          if (refreshToken) {
            await get().refresh();
          }
          set({ isHydrated: true });
        },
      };
    },
    {
      name: PERSIST_KEY,
      partialize: (state) => ({
        refreshToken: state.refreshToken,
        did: state.did,
        handle: state.handle,
        email: state.email,
      }),
    }
  )
);

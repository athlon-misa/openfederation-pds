import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setTokenGetter } from '@/lib/api-client';
import { createSession, refreshSession, getSession, resolveExternal, completeExternalLogin } from '@/lib/api/auth';

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
  logout: () => void;
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

        logout: () => {
          set({
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
          });
        },

        refresh: async () => {
          const { refreshToken } = get();
          if (!refreshToken) return false;

          const result = await refreshSession(refreshToken);
          if (!result.ok) {
            // If refresh fails, log out
            get().logout();
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
        },

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
      name: 'openfed-auth',
      partialize: (state) => ({
        refreshToken: state.refreshToken,
        did: state.did,
        handle: state.handle,
        email: state.email,
      }),
    }
  )
);

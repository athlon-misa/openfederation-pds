import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setTokenGetter } from '@/lib/api-client';
import { createSession, refreshSession, getSession } from '@/lib/api/auth';

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
  isHydrated: boolean;

  login: (identifier: string, password: string) => Promise<{ ok: true } | { ok: false; error: string; message: string }>;
  logout: () => void;
  refresh: () => Promise<boolean>;
  hydrate: () => Promise<void>;
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

          // Fetch roles from getSession
          const sessionResult = await getSession();
          if (sessionResult.ok) {
            set({
              roles: sessionResult.data.roles,
              status: sessionResult.data.status,
              isAdmin: sessionResult.data.roles.includes('admin'),
            });
          }

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

          // Fetch roles
          const sessionResult = await getSession();
          if (sessionResult.ok) {
            set({
              roles: sessionResult.data.roles,
              status: sessionResult.data.status,
              isAdmin: sessionResult.data.roles.includes('admin'),
            });
          }

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

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  isAuthenticated: boolean;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  } | null;
  tenantId: string | null;
  token: string | null;
  login: (token: string, user: AuthState['user'], tenantId: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      tenantId: null,
      token: null,
      login: (token, user, tenantId) => {
        localStorage.setItem('auth_token', token);
        set({ isAuthenticated: true, user, tenantId, token });
      },
      logout: () => {
        localStorage.removeItem('auth_token');
        set({ isAuthenticated: false, user: null, tenantId: null, token: null });
      },
    }),
    {
      name: 'auth-storage',
    }
  )
);

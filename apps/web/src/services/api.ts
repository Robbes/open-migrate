import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../stores/auth-store';

/**
 * Clear all auth state on an unauthorized response. The token is mirrored in the
 * raw `auth_token` key AND the zustand-persisted `auth-storage`; clearing only
 * one leaves `isAuthenticated` stale (the app would look logged-in while every
 * request 401s). `logout()` resets state + both keys, keeping them consistent.
 */
export function onUnauthorized(): void {
  useAuthStore.getState().logout();
  const win = globalThis as unknown as { location?: { href: string } };
  if (win.location) {
    win.location.href = '/login';
  }
}

// Create axios instance with default config
const apiClient: AxiosInstance = axios.create({
  baseURL: (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor - add auth token to requests
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('auth_token');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor - handle errors
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Token expired or invalid — clear ALL auth state and redirect to login.
      onUnauthorized();
    }
    return Promise.reject(error);
  }
);

export default apiClient;

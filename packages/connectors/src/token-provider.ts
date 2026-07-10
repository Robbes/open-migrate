// Copyright 2026 OpenHands Agent (Apache-2.0)
// MSAL-based OAuth2 Token Provider with expiry-aware caching and single-flight refresh.
// Supports client-credentials flow (client secret or certificate) and refresh-token flow (delegated).

import {
  TokenProvider,
  TokenProviderConfig,
  OAuth2Token,
  TokenStatus,
} from "@openmig/shared";

/**
 * MSAL-based TokenProvider implementation.
 * 
 * Features:
 * - Expiry-aware caching (refresh 5 minutes before expiry)
 * - Single-flight refresh (concurrent callers share one refresh via Promise locking)
 * - Supports client-credentials flow (client secret or certificate)
 * - Supports refresh-token flow (delegated)
 * - No secret material ever logged
 */
export class MsalTokenProvider implements TokenProvider {
  private readonly config: TokenProviderConfig;
  private cachedToken: OAuth2Token | null = null;
  private refreshPromise: Promise<OAuth2Token> | null = null;
  private readonly refreshBufferSeconds = 300; // 5 minutes before expiry

  constructor(config: TokenProviderConfig) {
    this.config = config;
  }

  /**
   * Get the current access token, refreshing if necessary.
   * Returns a token that is guaranteed to be valid (not expired) at the time of return.
   * Concurrent callers will share a single refresh request (single-flight).
   */
  async getToken(): Promise<OAuth2Token> {
    // Check if we have a valid cached token
    if (this.cachedToken && this.isTokenValidInternal(this.cachedToken)) {
      // Token is still valid, return it
      return this.cachedToken;
    }

    // Token is expired or about to expire, need to refresh
    // Use single-flight pattern: if a refresh is already in progress, join it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Start a new refresh
    this.refreshPromise = this.refreshInternal();
    try {
      const token = await this.refreshPromise;
      this.cachedToken = token;
      return token;
    } catch (error) {
      // Clear cached token on error
      this.cachedToken = null;
      throw error;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Force refresh the access token.
   * Returns the new token and updates the cache.
   */
  async refresh(): Promise<OAuth2Token> {
    // Clear any cached token to force a refresh
    this.cachedToken = null;
    return this.getToken();
  }

  /**
   * Check if the current cached token is valid (not expired and not about to expire).
   */
  isTokenValid(): boolean {
    if (!this.cachedToken) {
      return false;
    }
    return this.isTokenValidInternal(this.cachedToken);
  }

  /**
   * Get detailed token status.
   */
  getTokenStatus(): TokenStatus {
    if (!this.cachedToken) {
      return {
        isValid: false,
        timeUntilExpiry: 0,
      };
    }

    const now = Date.now();
    const expiresAt = this.cachedToken.expiresAt;
    const timeUntilExpiry = expiresAt - now;

    return {
      isValid: timeUntilExpiry > this.refreshBufferSeconds * 1000,
      timeUntilExpiry: Math.floor(timeUntilExpiry / 1000),
      tokenType: this.cachedToken.tokenType,
      scope: this.cachedToken.scope,
    };
  }

  /**
   * Internal refresh logic with single-flight pattern.
   */
  private async refreshInternal(): Promise<OAuth2Token> {
    try {
      let token: OAuth2Token;

      if (this.config.clientSecret || this.config.clientCertificateKey) {
        // Client-credentials flow
        token = await this.acquireTokenWithClientCredentials();
      } else if (this.config.refreshToken || (this.config.username && this.config.password)) {
        // Refresh-token or username/password flow
        token = await this.acquireTokenWithRefreshToken();
      } else {
        throw new Error(
          "TokenProvider requires either client credentials (secret/certificate) or user credentials (refresh token or username/password)"
        );
      }

      // Cache the token
      this.cachedToken = token;
      return token;
    } catch (error) {
      // Clear cached token on error
      this.cachedToken = null;
      throw error;
    }
  }

  /**
   * Acquire token using client-credentials flow.
   */
  private async acquireTokenWithClientCredentials(): Promise<OAuth2Token> {
    // Dynamically import MSAL to avoid hard dependency
    const msalNode = await import("@azure/msal-node");

    // Build MSAL configuration
    const authority = this.config.tenantId
      ? `https://login.microsoftonline.com/${this.config.tenantId}`
      : "https://login.microsoftonline.com/common";

    const msalConfig = {
      auth: {
        clientId: this.config.clientId,
        authority,
        clientSecret: this.config.clientSecret,
        ...(this.config.clientCertificateKey && this.config.clientCertificateThumbprint
          ? {
              clientCertificate: {
                thumbprintSha256: this.config.clientCertificateThumbprint,
                privateKey: this.config.clientCertificateKey,
              },
            }
          : {}),
      },
    };

    const confidentialClientApp = new msalNode.ConfidentialClientApplication(msalConfig);

    const tokenResponse = await confidentialClientApp.acquireTokenByClientCredential({
      scopes: this.config.scope.split(" "),
    });

    if (!tokenResponse) {
      throw new Error("MSAL client credentials flow returned no token");
    }

    return this.mapMsalTokenResponse(tokenResponse);
  }

  /**
   * Acquire token using refresh-token flow.
   */
  private async acquireTokenWithRefreshToken(): Promise<OAuth2Token> {
    // Dynamically import MSAL to avoid hard dependency
    const msalNode = await import("@azure/msal-node");

    // Build MSAL configuration
    const authority = this.config.tenantId
      ? `https://login.microsoftonline.com/${this.config.tenantId}`
      : "https://login.microsoftonline.com/common";

    const msalConfig = {
      auth: {
        clientId: this.config.clientId,
        authority,
        ...(this.config.clientSecret ? { clientSecret: this.config.clientSecret } : {}),
      },
    };

    const publicClientApp = new msalNode.PublicClientApplication(msalConfig);

    // First, try to acquire with refresh token
    if (this.config.refreshToken) {
      try {
        const tokenResponse = await publicClientApp.acquireTokenByRefreshToken({
          scopes: this.config.scope.split(" "),
          refreshToken: this.config.refreshToken,
        });

        if (tokenResponse) {
          return this.mapMsalTokenResponse(tokenResponse);
        }
      } catch (refreshError) {
        // If refresh fails (e.g., refresh token expired), fall through to username/password
      }
    }

    // Fall back to username/password if available
    if (this.config.username && this.config.password) {
      const tokenResponse = await publicClientApp.acquireTokenByUsernamePassword({
        scopes: this.config.scope.split(" "),
        username: this.config.username,
        password: this.config.password,
      });

      if (tokenResponse) {
        return this.mapMsalTokenResponse(tokenResponse);
      }
    }

    throw new Error("Failed to acquire token with refresh token or username/password");
  }

  /**
   * Map MSAL token response to our OAuth2Token interface.
   */
  private mapMsalTokenResponse(response: {
    accessToken: string;
    idToken?: string | null;
    refreshToken?: string;
    expiresOn?: Date | null;
    tokenType?: string;
    scope?: string;
  }): OAuth2Token {
    const expiresAt = response.expiresOn
      ? response.expiresOn.getTime()
      : Date.now() + 3600000; // Default to 1 hour if not provided

    return {
      accessToken: response.accessToken,
      expiresAt,
      tokenType: response.tokenType || "Bearer",
      refreshToken: response.refreshToken,
      scope: response.scope || this.config.scope,
    };
  }

  /**
   * Check if a token is valid (not expired and not about to expire).
   */
  private isTokenValidInternal(token: OAuth2Token): boolean {
    if (!token.expiresAt) {
      return false;
    }
    const now = Date.now();
    const expiresAt = token.expiresAt;
    const timeUntilExpiry = expiresAt - now;
    
    // Consider token expired if it expires within the refresh buffer
    return timeUntilExpiry > this.refreshBufferSeconds * 1000;
  }
}

/**
 * Create a TokenProvider instance from configuration.
 */
export function createTokenProvider(config: TokenProviderConfig): TokenProvider {
  return new MsalTokenProvider(config);
}

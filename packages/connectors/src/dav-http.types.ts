// Copyright 2026 OpenHands Agent (Apache-2.0)
// Shared HTTP client types for DAV connectors (CalDAV, CardDAV, WebDAV)

/** HTTP client interface for DAV requests. */
export interface HttpClient {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}

/** HTTP request options for DAV requests. */
export interface HttpRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
}

/** HTTP response from DAV requests. */
export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

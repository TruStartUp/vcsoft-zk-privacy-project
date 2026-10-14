import { randomBytes } from "node:crypto";

import { signRequest } from "../../src/lib/signing.js";

export interface PartnerCredentials {
  partnerKey: string;
  secret: string;
}

export interface SignatureOverrides {
  nonce?: string;
  timestamp?: number;
  signature?: string;
  partnerKey?: string;
}

export function signedHeaders(
  credentials: PartnerCredentials,
  method: string,
  path: string,
  body: Buffer = Buffer.alloc(0),
  overrides: SignatureOverrides = {},
): Record<string, string> {
  const timestamp = String(overrides.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? randomBytes(12).toString("hex");
  const signature =
    overrides.signature ?? signRequest(credentials.secret, { method, path, timestamp, nonce, body });
  const headers: Record<string, string> = {
    "x-partner-key": overrides.partnerKey ?? credentials.partnerKey,
    "x-partner-timestamp": timestamp,
    "x-partner-nonce": nonce,
    "x-partner-signature": signature,
  };
  if (body.length > 0) headers["content-type"] = "application/json";
  return headers;
}

export interface Reply<T = any> {
  status: number;
  body: T;
  ms: number;
}

export class StressClient {
  constructor(
    readonly baseUrl: string,
    readonly credentials: PartnerCredentials,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown, overrides: SignatureOverrides = {}): Promise<Reply<T>> {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
    const started = performance.now();
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: signedHeaders(this.credentials, method, path, raw, overrides),
      body: body === undefined ? undefined : raw,
    });
    const text = await response.text();
    const ms = performance.now() - started;
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed as T, ms };
  }

  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }

  put<T = any>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }
}

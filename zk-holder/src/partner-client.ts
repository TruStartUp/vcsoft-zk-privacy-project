import { createHash, createHmac, randomBytes } from "node:crypto";

export const SIGNATURE_SCHEME = "VCSOFT-HMAC-SHA256";

export interface PartnerCredentials {
  partnerKey: string;
  secret: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code: string;
  details?: Record<string, unknown>;
}

export function canonicalRequest(method: string, path: string, timestamp: string, nonce: string, body: Buffer): string {
  return [
    SIGNATURE_SCHEME,
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
}

export function signCanonical(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

/// A partner of the verification API. Every request is signed over its method,
/// path with query, timestamp, single-use nonce and body digest.
export class PartnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: PartnerCredentials,
    private readonly actor?: string,
  ) {}

  get partnerKey(): string {
    return this.credentials.partnerKey;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const headers: Record<string, string> = {
      "x-partner-key": this.credentials.partnerKey,
      "x-partner-timestamp": timestamp,
      "x-partner-nonce": nonce,
      "x-partner-signature": signCanonical(this.credentials.secret, canonicalRequest(method, path, timestamp, nonce, raw)),
    };
    if (this.actor) headers["x-partner-actor"] = this.actor;
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : raw,
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed as T };
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }

  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }
}

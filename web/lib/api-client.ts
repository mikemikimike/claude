// Default to same-origin /api now that the Next.js backend runs in the same
// project. NEXT_PUBLIC_API_URL overrides this (e.g. when a preview frontend
// needs to point at a different backend).
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api';

let tokenGetter: (() => Promise<string>) | null = null;

/** Pass null on logout so a stale getter can't mint a token for the next user. */
export function setTokenGetter(fn: (() => Promise<string>) | null) {
  tokenGetter = fn;
}

export class ApiError extends Error {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(status: number, statusText: string, body: any, bodyText?: string) {
    const bodyMsg =
      (body && typeof body === 'object' && typeof body.message === 'string' && body.message) ||
      (body && typeof body === 'object' && typeof body.error === 'string' && body.error) ||
      (typeof bodyText === 'string' && bodyText.trim()) ||
      '';
    const parts = [String(status), statusText, bodyMsg].filter(Boolean);
    super(parts.join(' — '));
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };

  if (tokenGetter) {
    // Race the Auth0 silent-auth call against a 10 s ceiling. Without this,
    // a stalled getAccessTokenSilently call hangs the entire request forever
    // (issues #106, #107, #108).
    const token = await Promise.race<string>([
      tokenGetter(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auth token request timed out')), 10_000)
      ),
    ]);
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let body: unknown = null;
    let bodyText: string | undefined;
    try {
      bodyText = await res.text();
      if (bodyText) {
        try { body = JSON.parse(bodyText); } catch { /* not JSON, keep text */ }
      }
    } catch { /* ignore */ }
    throw new ApiError(res.status, res.statusText, body, bodyText);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Authenticated fetch for BINARY responses (e.g. the admin page-image PNG that backs
// the placement overlay). A plain <img src> can't send the Bearer header, so the
// caller fetches the blob here and renders it via an object URL.
async function requestBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (tokenGetter) {
    const token = await Promise.race<string>([
      tokenGetter(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auth token request timed out')), 10_000)
      ),
    ]);
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Page rendering is server-side pdfjs+canvas — allow more headroom than JSON calls.
  const res = await fetch(`${BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    let bodyText: string | undefined;
    try { bodyText = await res.text(); } catch { /* ignore */ }
    let body: unknown = null;
    if (bodyText) { try { body = JSON.parse(bodyText); } catch { /* keep text */ } }
    throw new ApiError(res.status, res.statusText, body, bodyText);
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  getBlob: (path: string) => requestBlob(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

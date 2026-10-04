// Thin client for the TeamBot server API.
import type { SharedFile } from '@teambot/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The response, e.g. the page as it is now with a 409. */
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

let onSignedOut = () => {};
/** Called when the server says the session is gone (team mode), so the app can show the sign-in page. */
export function whenSignedOut(fn: () => void) {
  onSignedOut = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth')) onSignedOut();
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Put a file in /shared (under uploads/<today>/ unless a folder is given). */
async function upload(file: File, dir?: string): Promise<SharedFile> {
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(`${file.name} is larger than 25 MB`, 413);
  const query = new URLSearchParams({ name: file.name, ...(dir ? { dir } : {}) });
  const res = await fetch(`/api/shared/upload?${query}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const data = (await res.json().catch(() => null)) as (SharedFile & { error?: string }) | null;
  if (!res.ok || !data) throw new ApiError(data?.error ?? `Upload failed (${res.status})`, res.status);
  return data;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload,
};

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api${path}`;
}

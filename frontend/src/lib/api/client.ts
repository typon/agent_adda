type JsonBody = Record<string, unknown> | unknown[] | null;

const env = import.meta.env as Record<string, string | undefined>;
const apiRoot = normalizeApiRoot(env.PUBLIC_AGENT_ADDA_API_BASE ?? env.PUBLIC_API_BASE ?? "");

export async function fetchJson<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {}
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "same-origin",
    headers: withHeaders(init.headers, { Accept: "application/json" })
  });

  if (!response.ok) {
    throw apiError(response, path);
  }

  return response.json() as Promise<T>;
}

export async function postJson<T>(
  path: string,
  body?: JsonBody,
  init: RequestInit & { signal?: AbortSignal } = {}
): Promise<T> {
  return fetchJson<T>(path, jsonInit("POST", body, init));
}

export async function putJson<T>(
  path: string,
  body?: JsonBody,
  init: RequestInit & { signal?: AbortSignal } = {}
): Promise<T> {
  return fetchJson<T>(path, jsonInit("PUT", body, init));
}

export async function patchJson<T>(
  path: string,
  body?: JsonBody,
  init: RequestInit & { signal?: AbortSignal } = {}
): Promise<T> {
  return fetchJson<T>(path, jsonInit("PATCH", body, init));
}

export async function deleteJson(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {}
): Promise<void> {
  const response = await fetch(apiUrl(path), {
    ...init,
    method: "DELETE",
    credentials: "same-origin",
    headers: withHeaders(init.headers, { Accept: "application/json" })
  });

  if (!response.ok) {
    throw apiError(response, path);
  }
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${apiRoot}/api/v1${normalizedPath}`;
}

function jsonInit(
  method: string,
  body: JsonBody | undefined,
  init: RequestInit & { signal?: AbortSignal }
): RequestInit & { signal?: AbortSignal } {
  const headers = body === undefined
    ? init.headers
    : withHeaders(init.headers, { "Content-Type": "application/json" });

  return {
    ...init,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers
  };
}

function apiError(response: Response, path: string): Error {
  const error = new Error(`API ${response.status} ${response.statusText} for ${path}`);
  return Object.assign(error, {
    status: response.status,
    path
  });
}

function normalizeApiRoot(value: string): string {
  return value.replace(/\/+$/, "");
}

function withHeaders(headers: HeadersInit | undefined, defaults: Record<string, string>): Headers {
  const nextHeaders = new Headers(headers);

  for (const [key, value] of Object.entries(defaults)) {
    if (!nextHeaders.has(key)) {
      nextHeaders.set(key, value);
    }
  }

  return nextHeaders;
}

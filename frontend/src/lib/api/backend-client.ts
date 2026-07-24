import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const configuredApiBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

export const apiBaseUrl =
  typeof window !== "undefined" &&
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configuredApiBaseUrl)
    ? "/api/backend"
    : configuredApiBaseUrl;

let cachedAccessToken = "";

type SessionResponse = Awaited<
  ReturnType<ReturnType<typeof getSupabaseBrowserClient>["auth"]["getSession"]>
>;

export function setCachedAccessToken(token: string | undefined) {
  cachedAccessToken = token ?? "";
}

export function hasCachedAccessToken() {
  return Boolean(cachedAccessToken);
}

export async function getSessionWithTimeout(
  timeoutMs = 1500,
): Promise<SessionResponse | null> {
  const supabase = getSupabaseBrowserClient();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const sessionResponse = await Promise.race([
      supabase.auth.getSession(),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    setCachedAccessToken(sessionResponse?.data.session?.access_token);
    return sessionResponse;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function apiFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const sessionResponse = await getSessionWithTimeout();
  const token = sessionResponse?.data.session?.access_token ?? cachedAccessToken;

  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export async function responseErrorMessage(
  response: Response,
  fallback: string,
) {
  const body = await response.json().catch(() => null);
  const message = body?.message;
  if (Array.isArray(message)) return message.join(" ");
  return typeof message === "string" && message.trim() ? message : fallback;
}

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export const apiBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

export async function apiFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

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

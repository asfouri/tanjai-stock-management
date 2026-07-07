import { NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const backendBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

type SupabasePasswordResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  msg?: string;
};

function relativeRedirect(location: string) {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location },
  });
}

function loginRedirect(message?: string) {
  const params = new URLSearchParams();
  if (message) params.set("message", message);
  const query = params.toString();
  return relativeRedirect(`/login${query ? `?${query}` : ""}`);
}

function isSecureRequest(request: Request) {
  return (
    request.url.startsWith("https://") ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return loginRedirect("Enter both email and password.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  const backendResponse = await fetch(`${backendBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: controller.signal,
  }).catch((error: unknown) => {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Login request timed out. Try again."
        : "Unable to reach backend login.";
    return new Response(JSON.stringify({ error_description: message }), {
      status: 504,
      headers: { "Content-Type": "application/json" },
    });
  });
  clearTimeout(timeoutId);

  const backendBody = (await backendResponse.json().catch(() => null)) as
    | { accessToken?: string; expiresIn?: number; message?: string }
    | null;

  if (backendResponse.ok && backendBody?.accessToken) {
    const redirect = relativeRedirect("/dashboard");
    redirect.cookies.set("tanjai_access_token", backendBody.accessToken, {
      httpOnly: true,
      maxAge: backendBody.expiresIn ?? 24 * 60 * 60,
      path: "/",
      sameSite: "lax",
      secure: isSecureRequest(request),
    });

    return redirect;
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return loginRedirect(backendBody?.message || "Auth is not configured.");
  }

  const supabaseController = new AbortController();
  const supabaseTimeoutId = setTimeout(() => supabaseController.abort(), 8000);

  const response = await fetch(
    `${supabaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ email, password }),
      signal: supabaseController.signal,
    }
  ).catch((error: unknown) => {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Auth request timed out. Try again."
        : "Unable to reach auth service.";
    return new Response(JSON.stringify({ error_description: message }), {
      status: 504,
      headers: { "Content-Type": "application/json" },
    });
  });
  clearTimeout(supabaseTimeoutId);

  const body = (await response.json().catch(() => null)) as
    | SupabasePasswordResponse
    | null;

  if (!response.ok || !body?.access_token) {
    return loginRedirect(
      body?.error_description || body?.msg || body?.error || "Unable to sign in."
    );
  }

  const redirect = relativeRedirect("/dashboard");
  redirect.cookies.set("tanjai_access_token", body.access_token, {
    httpOnly: true,
    maxAge: body.expires_in ?? 3600,
    path: "/",
    sameSite: "lax",
    secure: isSecureRequest(request),
  });

  return redirect;
}

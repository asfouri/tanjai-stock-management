"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

function getAuthErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message && error.message !== "{}"
      ? error.message
      : "Unable to reach Supabase Auth. Check your network connection.";
  }

  return "Unable to reach Supabase Auth. Check your network connection.";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function checkSession() {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data } = await supabase.auth.getSession();

        if (data.session) {
          router.replace("/dashboard");
          return;
        }
      } catch (error) {
        if (isMounted) {
          setMessage(getAuthErrorMessage(error));
        }
      }

      if (isMounted) {
        setIsCheckingSession(false);
      }
    }

    checkSession();

    return () => {
      isMounted = false;
    };
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      setMessage("Enter both email and password.");
      return;
    }

    if (!trimmedEmail.includes("@")) {
      setMessage("Enter a valid email address.");
      return;
    }

    setIsSubmitting(true);

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        setMessage(getAuthErrorMessage(error));
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      setMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-12 text-zinc-950">
      <section className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="mb-8">
          <p className="text-sm font-medium text-zinc-500">TanjAI Stock</p>
          <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
        </div>

        {isCheckingSession ? (
          <p className="text-sm text-zinc-600">Checking your session...</p>
        ) : (
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="email">
                Email
              </label>
              <input
                className="h-11 w-full rounded-md border border-zinc-300 px-3 text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="password">
                Password
              </label>
              <div className="flex h-11 overflow-hidden rounded-md border border-zinc-300 bg-white transition focus-within:border-zinc-900 focus-within:ring-2 focus-within:ring-zinc-900/10">
                <input
                  className="min-w-0 flex-1 px-3 text-sm outline-none"
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  className="w-16 border-l border-zinc-200 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {message ? (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {message}
              </p>
            ) : null}

            <button
              className="h-11 w-full rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

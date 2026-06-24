"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function loadSession() {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data, error } = await supabase.auth.getUser();

        if (error || !data.user) {
          router.replace("/login");
          return;
        }

        if (isMounted) {
          setUser(data.user);
          setIsLoading(false);
        }
      } catch (error) {
        if (isMounted) {
          setMessage(
            error instanceof Error
              ? error.message
              : "Unable to verify your session."
          );
          setIsLoading(false);
        }
      }
    }

    loadSession();

    return () => {
      isMounted = false;
    };
  }, [router]);

  async function handleLogout() {
    setMessage("");

    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to sign out right now."
      );
    }
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 text-sm text-zinc-600">
        Loading dashboard...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-8 text-zinc-950">
      <section className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 border-b border-zinc-200 pb-5">
        <div>
          <p className="text-sm font-medium text-zinc-500">TanjAI Stock</p>
          <h1 className="mt-1 text-2xl font-semibold">Dashboard</h1>
        </div>
        <button
          className="h-10 rounded-md border border-zinc-300 bg-white px-4 text-sm font-medium transition hover:bg-zinc-100"
          type="button"
          onClick={handleLogout}
        >
          Logout
        </button>
      </section>

      <section className="mx-auto mt-8 w-full max-w-4xl rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-zinc-500">Signed in as</p>
        <p className="mt-2 text-lg font-medium">{user?.email}</p>

        {message ? (
          <p className="mt-5 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}

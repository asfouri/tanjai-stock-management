import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | null = null;

const supabaseFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    return new Response(
      JSON.stringify({
        error: "network_error",
        error_description:
          "Unable to reach Supabase Auth. Check your network connection.",
        msg: "Unable to reach Supabase Auth. Check your network connection.",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
};

export function getSupabaseBrowserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase public environment variables are missing.");
  }

  supabase ??= createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      fetch: supabaseFetch,
    },
  });

  return supabase;
}

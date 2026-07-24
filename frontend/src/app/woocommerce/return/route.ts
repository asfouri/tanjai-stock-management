const backendBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  try {
    const response = await fetch(
      `${backendBaseUrl}/woocommerce/return${incoming.search}`,
      { redirect: "manual" },
    );
    const location = response.headers.get("location");
    if (location) return Response.redirect(location, 302);
    return new Response(response.body, { status: response.status });
  } catch {
    const fallback = new URL("/dashboard", incoming.origin);
    fallback.searchParams.set("section", "integrations");
    fallback.searchParams.set("woocommerce", "failed");
    return Response.redirect(fallback, 302);
  }
}

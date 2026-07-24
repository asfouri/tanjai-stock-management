const backendBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

export async function POST(request: Request) {
  const headers = new Headers();
  headers.set(
    "content-type",
    request.headers.get("content-type") || "application/json",
  );
  try {
    const response = await fetch(`${backendBaseUrl}/woocommerce/callback`, {
      method: "POST",
      headers,
      body: await request.arrayBuffer(),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json(
      { message: "The WooCommerce callback could not reach the backend.", details: String(error) },
      { status: 502 },
    );
  }
}

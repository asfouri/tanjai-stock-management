const backendBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

type RouteContext = {
  params: Promise<{ connectionPublicId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { connectionPublicId } = await context.params;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (name.startsWith("x-wc-") || name === "content-type") {
      headers.set(name, value);
    }
  }
  try {
    const response = await fetch(
      `${backendBaseUrl}/webhooks/woocommerce/${encodeURIComponent(connectionPublicId)}`,
      {
        method: "POST",
        headers,
        body: await request.arrayBuffer(),
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json(
      { message: "The WooCommerce webhook could not reach the backend.", details: String(error) },
      { status: 502 },
    );
  }
}

const backendBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

export async function POST(request: Request) {
  const headers = new Headers();
  headers.set(
    "content-type",
    request.headers.get("content-type") || "application/json",
  );
  const signature = request.headers.get("sign");
  if (signature) headers.set("sign", signature);

  try {
    const response = await fetch(`${backendBaseUrl}/webhooks/17track`, {
      method: "POST",
      headers,
      body: await request.arrayBuffer(),
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") || "application/json",
      },
    });
  } catch {
    return Response.json(
      { message: "The 17TRACK webhook could not reach the backend." },
      { status: 502 },
    );
  }
}

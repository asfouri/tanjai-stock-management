const backendBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

type RouteContext = {
  params: Promise<{ action: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { action } = await context.params;
  if (!['start', 'launch', 'callback'].includes(action)) {
    return Response.json({ message: "Shopify route not found." }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const backendUrl = `${backendBaseUrl}/shopify/${action}${requestUrl.search}`;
  const headers = new Headers();
  const cookieHeader = request.headers.get('cookie');
  const token = readCookie(cookieHeader, 'tanjai_access_token');
  if (action === 'start' && !token) {
    return Response.redirect(new URL('/login', request.url), 303);
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (cookieHeader) headers.set('Cookie', cookieHeader);
  headers.set('X-Forwarded-Proto', requestUrl.protocol.replace(':', ''));

  let backendResponse: Response;
  try {
    backendResponse = await fetch(backendUrl, {
      headers,
      redirect: "manual",
    });
  } catch {
    return Response.json(
      {
        message:
          "Cannot reach the backend server. Start it on port 3005 and try again.",
      },
      { status: 502 },
    );
  }

  const location = backendResponse.headers.get("location");
  const responseHeaders = new Headers(backendResponse.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  if (location && backendResponse.status >= 300 && backendResponse.status < 400) {
    return new Response(null, {
      status: backendResponse.status,
      headers: responseHeaders,
    });
  }

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    headers: responseHeaders,
  });
}

function readCookie(cookieHeader: string | null, name: string) {
  const encoded = cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return encoded ? decodeURIComponent(encoded) : "";
}

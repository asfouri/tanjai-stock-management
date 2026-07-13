const backendBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

function buildBackendUrl(path: string[] | undefined, requestUrl: string) {
  const url = new URL(requestUrl);
  const backendPath = (path ?? []).map(encodeURIComponent).join("/");
  return `${backendBaseUrl}/${backendPath}${url.search}`;
}

function localFallbackUrl(url: string) {
  if (url.startsWith("http://localhost:")) {
    return url.replace("http://localhost:", "http://127.0.0.1:");
  }
  if (url.startsWith("http://127.0.0.1:")) {
    return url.replace("http://127.0.0.1:", "http://localhost:");
  }
  return null;
}

async function proxyRequest(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const headers = new Headers(request.headers);
  const cookieToken = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("tanjai_access_token="))
    ?.slice("tanjai_access_token=".length);

  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  if (cookieToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${decodeURIComponent(cookieToken)}`);
  }

  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const backendUrl = buildBackendUrl(path, request.url);
  const fallbackUrl = localFallbackUrl(backendUrl);
  let response: Response;

  try {
    response = await fetch(backendUrl, {
      method,
      headers,
      body,
    });
  } catch (error) {
    if (!fallbackUrl) {
      return backendUnavailableResponse(error);
    }

    try {
      response = await fetch(fallbackUrl, {
        method,
        headers,
        body,
      });
    } catch (fallbackError) {
      return backendUnavailableResponse(fallbackError);
    }
  }

  // fetch already decompressed the backend response; forwarding the original
  // content-encoding/length headers would make the browser decode plain JSON
  // as gzip ("Decoding failed.").
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function backendUnavailableResponse(error: unknown) {
  const details = error instanceof Error ? error.message : String(error);

  return Response.json(
    {
      message:
        "Cannot reach the backend server. Start the backend on port 3005, then refresh the dashboard.",
      details,
    },
    { status: 502 },
  );
}

export function GET(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export function POST(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export function PATCH(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export function DELETE(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

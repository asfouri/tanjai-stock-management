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

  const response = await fetch(buildBackendUrl(path, request.url), {
    method,
    headers,
    body,
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function GET(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export function POST(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

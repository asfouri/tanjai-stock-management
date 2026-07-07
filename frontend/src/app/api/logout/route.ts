import { NextResponse } from "next/server";

export function POST() {
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: "/login" },
  });
  response.cookies.delete("tanjai_access_token");
  return response;
}

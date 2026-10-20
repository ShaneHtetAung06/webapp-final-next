//src/app/api/auth/logout/route.js

import corsHeaders from "@/lib/cors";
import { successResponse } from "@/lib/utils";
import { NextResponse } from "next/server";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req) {
  const response = successResponse({ message: "Logout successful" }, 200);

  // Clear the token cookie
  response.cookies.set("token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}

//src/app/api/user/route.js

import corsHeaders from "@/lib/cors";

import { getClientPromise } from "@/lib/mongodb";

import { NextResponse } from "next/server";

import bcrypt from "bcrypt";

import { errorResponse, successResponse } from "@/lib/utils";

export async function GET(request) {
  if (!isAdmin(request)) {
    return errorResponse("Unauthorized Request", 403);
  }

  const searchParams = request.nextUrl.searchParams;

  const pageParam = searchParams.get("page") || "1";

  let page = Number(pageParam) - 1;

  page = page < 0 ? 0 : page;

  const size = 10;

  try {
    const client = await getClientPromise();

    const db = client.db(process.env.DB_NAME);

    const result = await db

      .collection("user")

      .find({}, { projection: { password: 0 } })

      .skip(page * size)

      .limit(size)

      .toArray();

    const output = {
      users: result,

      page: page,

      size: size,
    };

    return successResponse(output, 201);
  } catch (error) {
    console.log("==>GET user exception");

    console.log(error);
  }

  return NextResponse.json({});
}

export async function POST(request) {
  if (!isAdmin(request)) {
    return errorResponse("Unauthorized Request", 403);
  }

  const data = await request.json();
  const name = data.name;
  const username = data.username;
  const email = data.email;
  const password = data.password;
  const role = data.role;

  if (!username || !email || !password || !name || !role) {
    return errorResponse("Missing mandatory data", 400);
  }

  try {
    const client = await getClientPromise();

    const db = client.db(process.env.DB_NAME);

    const result = await db.collection("user").insertOne({
      name: name,
      username: username,
      email: email,
      password: await bcrypt.hash(password, 12),
      role: role,
    });

    console.log("==>Insert User Result:", result);

    return successResponse({ id: result.insertedId }, 200);
  } catch (error) {
    console.log("==>POST user exception");

    const errorResponseMessage = error.errorResponse.errmsg;

    console.log(errorResponseMessage);

    let errorType;

    let errorMsg;

    if (errorResponseMessage.includes("duplicate")) {
      errorMsg = errorResponseMessage.includes("username")
        ? "username"
        : "email";

      errorType = "Duplicate Data";
    } else {
      errorType = "Others";

      errorMsg = errorResponseMessage;
    }

    return NextResponse.json(
      {
        errorType: errorType,

        errorMsg: errorMsg,
      },

      {
        status: 400,

        headers: corsHeaders,
      },
    );
  }
}

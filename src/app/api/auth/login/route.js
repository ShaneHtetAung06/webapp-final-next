//src/app/api/auth/login/route.js

import corsHeaders from "@/lib/cors";
import { errorResponse, successResponse } from "@/lib/utils";
import { getClientPromise } from "@/lib/mongodb";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req) {
  try {
    const { email, password } = await req.json();

    // Validate input
    if (!email || !password) {
      return errorResponse("Email and password are required", 400);
    }

    const client = await getClientPromise();
    const db = client.db(process.env.DB_NAME);
    const usersCollection = db.collection("user");

    const user = await usersCollection.findOne({ email });
    if (!user) {
      return errorResponse("Invalid email or password", 401);
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return errorResponse("Invalid email or password", 401);
    }

    const token = jwt.sign(
      {
        id: user._id.toString(),
        email: user.email,
        username: user.username,
        role: user.role,
        name: user.name,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    const response = successResponse(
      {
        message: "Login successful",
        user: {
          id: user._id.toString(),
          email: user.email,
          username: user.username,
          name: user.name,
          role: user.role,
        },
      },
      200,
    );

    response.cookies.set("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 day
      path: "/",
    });

    return response;
  } catch (error) {
    console.log("==>Login Exception");
    console.log(error);
    return errorResponse("Internal Server Error", 500);
  }
}

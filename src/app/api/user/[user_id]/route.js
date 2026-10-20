//src/app/api/user/[user_id]/route.js

import corsHeaders from "@/lib/cors";
import { errorResponse, printExceptionLog, successResponse } from "@/lib/utils";
import { getClientPromise } from "@/lib/mongodb";
import { verifyJWT } from "@/lib/auth";
import {
  X_HEADER_USER_EMAIL,
  X_HEADER_USER_ID,
  X_HEADER_USER_NAME,
} from "@/lib/constant";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

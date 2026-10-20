//src/app/api/course/[course_id]/enroll/route.js

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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function authenticateUser(req, db) {
  let user = null;

  // 1. Try verifyJWT from cookie
  user = verifyJWT(req);

  if (!user) {
    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        user = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        // invalid token
      }
    }
  }

  // 3. Try custom headers set by middleware / proxy
  const headerUserId = req.headers.get(X_HEADER_USER_ID);
  const headerUserEmail = req.headers.get(X_HEADER_USER_EMAIL);
  const headerUserName = req.headers.get(X_HEADER_USER_NAME);

  if (!user && (headerUserId || headerUserEmail)) {
    user = {
      id: headerUserId,
      email: headerUserEmail,
      username: headerUserName,
    };
  }

  if (!user) {
    return null;
  }

  // Fetch full user record from database to verify role
  let dbUser = null;
  try {
    const query = [];
    if (user.id && ObjectId.isValid(user.id)) {
      query.push({ _id: new ObjectId(user.id) });
    }
    if (user.id) {
      query.push({ _id: user.id });
    }
    if (user.email) {
      query.push({ email: user.email });
    }

    if (query.length > 0) {
      dbUser = await db.collection("user").findOne({ $or: query });
    }
  } catch (err) {
    console.log("Error querying user for auth:", err);
  }

  return {
    id: dbUser?._id?.toString() || user.id,
    email: dbUser?.email || user.email,
    username: dbUser?.username || user.username,
    name: dbUser?.name || user.name || dbUser?.username || user.username,
    role: dbUser?.role || user.role,
  };
}

function resolveCourseQuery(courseIdParam) {
  const query = [];
  if (ObjectId.isValid(courseIdParam)) {
    query.push({ _id: new ObjectId(courseIdParam) });
  }
  query.push({ _id: courseIdParam });
  return { $or: query };
}

export async function POST(req, context) {
  try {
    const params = await context.params;
    const courseId = params?.course_id;

    if (!courseId) {
      return errorResponse("Course ID is required", 400);
    }

    const client = await getClientPromise();
    const db = client.db(process.env.DB_NAME);

    // 1. Authenticate user
    const user = await authenticateUser(req, db);
    if (!user) {
      return errorResponse("Unauthorized: Please log in to enroll", 401);
    }

    // 2. Authorize role: Student only
    if (user.role !== "student") {
      return errorResponse(
        "Forbidden: Only students can enroll in courses",
        403,
      );
    }

    // 3. Find course
    const course = await db
      .collection("course")
      .findOne(resolveCourseQuery(courseId));

    if (!course) {
      return errorResponse("Course not found", 404);
    }

    const statusLower = String(course.status || "").toLowerCase();
    if (statusLower === "cancel") {
      return errorResponse(
        "Course is cancelled and unavailable for enrollment",
        400,
      );
    }
    if (statusLower === "close") {
      return errorResponse(
        "Course is closed and not available for enrollment",
        400,
      );
    }
    if (statusLower !== "open") {
      return errorResponse(
        `Course status is '${course.status}'. Only 'Open' courses allow enrollment`,
        400,
      );
    }

    const rawStudents = course.enrolled_students || course.students || [];
    const isAlreadyEnrolled = rawStudents.some(
      (s) =>
        s === user.id ||
        s?.student_id === user.id ||
        s?.id === user.id ||
        s?.email === user.email,
    );

    if (isAlreadyEnrolled) {
      return errorResponse("You are already enrolled in this course", 400);
    }

    // 6. Max seat check: Seats must be available
    const maxStudents = Number(course.max_student ?? course.max_students ?? 0);
    if (rawStudents.length >= maxStudents) {
      return errorResponse(
        `Course is full. No seats available (Capacity: ${maxStudents})`,
        400,
      );
    }

    // 7. Perform enrollment
    const studentRecord = {
      student_id: user.id,
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      enrolled_at: new Date(),
    };

    await db.collection("course").updateOne(resolveCourseQuery(courseId), {
      $push: {
        enrolled_students: studentRecord,
        students: studentRecord,
      },
      $set: {
        updated_at: new Date(),
      },
    });

    try {
      const userConditions = [];
      if (ObjectId.isValid(user.id))
        userConditions.push({ _id: new ObjectId(user.id) });
      userConditions.push({ _id: user.id });
      userConditions.push({ email: user.email });
      await db.collection("user").updateOne(
        { $or: userConditions },
        {
          $addToSet: { enrolled_courses: courseId },
        },
      );
    } catch (e) {
      console.log("Could not update user enrolled_courses:", e);
    }

    const updatedCourse = await db
      .collection("course")
      .findOne(resolveCourseQuery(courseId));

    const updatedStudents =
      updatedCourse.enrolled_students || updatedCourse.students || [];

    return successResponse(
      {
        message: "Successfully enrolled in course",
        course: {
          ...updatedCourse,
          enrolled_count: updatedStudents.length,
          seats_available: Math.max(0, maxStudents - updatedStudents.length),
          is_enrolled: true,
          can_enroll: false,
        },
      },
      200,
    );
  } catch (error) {
    printExceptionLog("Enroll Course", error);
    return errorResponse("Internal Server Error: " + error.message, 500);
  }
}

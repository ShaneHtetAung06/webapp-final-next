//src/app/api/course/[course_id]/route.js

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

  // 2. Try Bearer token in Authorization header
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

/**
 * GET /api/course/[course_id] - Course detail
 *
 * Rules:
 * - Cancel: not displayed to Students/guests (404 Not Found)
 * - Open / Close: displayed with enrolled status and seat availability
 */
export async function GET(req, context) {
  try {
    const params = await context.params;
    const courseId = params?.course_id;

    if (!courseId) {
      return errorResponse("Course ID is required", 400);
    }

    const client = await getClientPromise();
    const db = client.db(process.env.DB_NAME);

    // Optional user authentication to personalize enrollment status
    const user = await authenticateUser(req, db);

    const course = await db
      .collection("course")
      .findOne(resolveCourseQuery(courseId));

    if (!course) {
      return errorResponse("Course not found", 404);
    }

    const isTeacher = user?.role === "teacher";
    const statusLower = String(course.status || "").toLowerCase();

    // Cancel: not displayed in the Student course list and detail
    if (!isTeacher && statusLower === "cancel") {
      return errorResponse("Course not found or is cancelled", 404);
    }

    const rawStudents = course.enrolled_students || course.students || [];
    let populatedStudents = [];

    if (Array.isArray(rawStudents) && rawStudents.length > 0) {
      const isIdList = rawStudents.every(
        (item) => typeof item === "string" || item instanceof ObjectId
      );

      if (isIdList) {
        const studentQueries = rawStudents.map((id) => {
          const conditions = [];
          if (ObjectId.isValid(id)) {
            conditions.push({ _id: new ObjectId(id) });
          }
          conditions.push({ _id: id });
          return { $or: conditions };
        });

        const users = await db
          .collection("user")
          .find({ $or: studentQueries })
          .project({ password: 0 })
          .toArray();

        populatedStudents = users;
      } else {
        populatedStudents = rawStudents;
      }
    }

    const maxStudents = Number(course.max_student ?? course.max_students ?? 0);
    const enrolledCount = rawStudents.length;
    const seatsAvailable = Math.max(0, maxStudents - enrolledCount);

    const isEnrolled = user
      ? rawStudents.some(
          (s) =>
            s === user.id ||
            s?.student_id === user.id ||
            s?.id === user.id ||
            s?.email === user.email
        )
      : false;

    const isOpen = statusLower === "open";
    const canEnroll =
      isOpen &&
      seatsAvailable > 0 &&
      !isEnrolled &&
      (!user || user.role === "student");

    const responseData = {
      course: {
        ...course,
        enrolled_count: enrolledCount,
        seats_available: seatsAvailable,
        is_enrolled: isEnrolled,
        can_enroll: canEnroll,
        is_full: seatsAvailable <= 0,
        enrolled_students: populatedStudents,
        students: populatedStudents,
      },
    };

    return successResponse(responseData, 200);
  } catch (error) {
    printExceptionLog("Get Course Detail", error);
    return errorResponse("Internal Server Error: " + error.message, 500);
  }
}

/**
 * POST /api/course/[course_id] - Enroll in course
 *
 * Rules:
 * - Only Students can enroll.
 * - Course status must be Open.
 * - Seats must be available (max seat).
 * - Cannot enroll same course twice.
 */
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
      return errorResponse("Forbidden: Only students can enroll in courses", 403);
    }

    // 3. Find course
    const course = await db
      .collection("course")
      .findOne(resolveCourseQuery(courseId));

    if (!course) {
      return errorResponse("Course not found", 404);
    }

    // 4. Status check: Must be Open
    const statusLower = String(course.status || "").toLowerCase();
    if (statusLower === "cancel") {
      return errorResponse("Course is cancelled and unavailable for enrollment", 400);
    }
    if (statusLower === "close") {
      return errorResponse("Course is closed and not available for enrollment", 400);
    }
    if (statusLower !== "open") {
      return errorResponse(
        `Course status is '${course.status}'. Only 'Open' courses allow enrollment`,
        400
      );
    }

    // 5. Duplicate check: Cannot enroll same course twice
    const rawStudents = course.enrolled_students || course.students || [];
    const isAlreadyEnrolled = rawStudents.some(
      (s) =>
        s === user.id ||
        s?.student_id === user.id ||
        s?.id === user.id ||
        s?.email === user.email
    );

    if (isAlreadyEnrolled) {
      return errorResponse("You are already enrolled in this course", 400);
    }

    // 6. Max seat check: Seats must be available
    const maxStudents = Number(course.max_student ?? course.max_students ?? 0);
    if (rawStudents.length >= maxStudents) {
      return errorResponse(
        `Course is full. No seats available (Capacity: ${maxStudents})`,
        400
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

    // Also update student's enrolled_courses list in user collection
    try {
      const userConditions = [];
      if (ObjectId.isValid(user.id)) userConditions.push({ _id: new ObjectId(user.id) });
      userConditions.push({ _id: user.id });
      userConditions.push({ email: user.email });
      await db.collection("user").updateOne(
        { $or: userConditions },
        {
          $addToSet: { enrolled_courses: courseId },
        }
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
      200
    );
  } catch (error) {
    printExceptionLog("Enroll Course", error);
    return errorResponse("Internal Server Error: " + error.message, 500);
  }
}

// PUT /api/course/[course_id] - Edit course (teacher can only edit their own course)
export async function PUT(req, context) {
  try {
    const params = await context.params;
    const courseId = params?.course_id;

    if (!courseId) {
      return errorResponse("Course ID is required", 400);
    }

    const client = await getClientPromise();
    const db = client.db(process.env.DB_NAME);

    // Authenticate user
    const user = await authenticateUser(req, db);
    if (!user) {
      return errorResponse("Unauthorized: Please log in", 401);
    }

    if (user.role !== "teacher") {
      return errorResponse("Forbidden: Only teachers can edit courses", 403);
    }

    // Find course
    const course = await db
      .collection("course")
      .findOne(resolveCourseQuery(courseId));

    if (!course) {
      return errorResponse("Course not found", 404);
    }

    // Check ownership: teacher can only edit their own course
    const isOwner =
      course.teacher_id === user.id ||
      course.teacher_id === user.id?.toString() ||
      course.teacher_email === user.email;

    if (!isOwner) {
      return errorResponse("Forbidden: You can only edit your own course", 403);
    }

    // Parse body
    let body;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON payload", 400);
    }

    const updateFields = {};

    const course_name =
      body.course_name ?? body.name ?? body.courseName ?? body.title;
    if (course_name !== undefined) {
      if (String(course_name).trim() === "") {
        return errorResponse("Course name cannot be empty", 400);
      }
      updateFields.course_name = String(course_name).trim();
      updateFields.name = String(course_name).trim();
    }

    const duration =
      body.duration ?? body.duration_days ?? body.durationDays;
    if (duration !== undefined) {
      if (isNaN(Number(duration)) || Number(duration) <= 0) {
        return errorResponse("Duration must be a positive number", 400);
      }
      updateFields.duration = Number(duration);
      updateFields.duration_days = Number(duration);
    }

    const rawTopics = body.topics;
    if (rawTopics !== undefined) {
      let topics = [];
      if (Array.isArray(rawTopics)) {
        topics = rawTopics.map((t) => String(t).trim()).filter(Boolean);
      } else if (typeof rawTopics === "string") {
        topics = rawTopics
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      if (topics.length === 0) {
        return errorResponse("At least one topic is required", 400);
      }
      updateFields.topics = topics;
    }

    const price = body.price;
    if (price !== undefined) {
      if (isNaN(Number(price)) || Number(price) < 0) {
        return errorResponse("Price must be a non-negative number", 400);
      }
      updateFields.price = Number(price);
    }

    const max_student =
      body.max_student ?? body.max_students ?? body.maxStudent;
    if (max_student !== undefined) {
      if (isNaN(Number(max_student)) || Number(max_student) <= 0) {
        return errorResponse("Max Student must be a positive number", 400);
      }
      updateFields.max_student = Number(max_student);
      updateFields.max_students = Number(max_student);
    }

    if (body.status !== undefined) {
      const validStatuses = ["Open", "Close", "Cancel"];
      const matchedStatus = validStatuses.find(
        (s) => s.toLowerCase() === String(body.status).trim().toLowerCase()
      );
      if (!matchedStatus) {
        return errorResponse("Status must be 'Open', 'Close', or 'Cancel'", 400);
      }
      updateFields.status = matchedStatus;
    }

    if (body.enrolled_students !== undefined) {
      updateFields.enrolled_students = body.enrolled_students;
      updateFields.students = body.enrolled_students;
    }

    updateFields.updated_at = new Date();

    await db
      .collection("course")
      .updateOne(resolveCourseQuery(courseId), { $set: updateFields });

    const updatedCourse = await db
      .collection("course")
      .findOne(resolveCourseQuery(courseId));

    return successResponse(
      {
        message: "Course updated successfully",
        course: updatedCourse,
      },
      200
    );
  } catch (error) {
    printExceptionLog("Update Course", error);
    return errorResponse("Internal Server Error: " + error.message, 500);
  }
}

// DELETE /api/course/[course_id] - Delete course (only if no students enrolled, teacher's own course)
export async function DELETE(req, context) {
  try {
    const params = await context.params;
    const courseId = params?.course_id;

    if (!courseId) {
      return errorResponse("Course ID is required", 400);
    }

    const client = await getClientPromise();
    const db = client.db(process.env.DB_NAME);

    // Authenticate user
    const user = await authenticateUser(req, db);
    if (!user) {
      return errorResponse("Unauthorized: Please log in", 401);
    }

    if (user.role !== "teacher") {
      return errorResponse("Forbidden: Only teachers can delete courses", 403);
    }

    // Find course
    const course = await db
      .collection("course")
      .findOne(resolveCourseQuery(courseId));

    if (!course) {
      return errorResponse("Course not found", 404);
    }

    // Check ownership: teacher can only delete their own course
    const isOwner =
      course.teacher_id === user.id ||
      course.teacher_id === user.id?.toString() ||
      course.teacher_email === user.email;

    if (!isOwner) {
      return errorResponse("Forbidden: You can only delete your own course", 403);
    }

    // Check if any student is enrolled
    const enrolledStudents =
      course.enrolled_students || course.students || [];
    if (Array.isArray(enrolledStudents) && enrolledStudents.length > 0) {
      return errorResponse(
        "Cannot delete course: Students are currently enrolled in this course",
        400
      );
    }

    await db.collection("course").deleteOne(resolveCourseQuery(courseId));

    return successResponse(
      {
        message: "Course deleted successfully",
      },
      200
    );
  } catch (error) {
    printExceptionLog("Delete Course", error);
    return errorResponse("Internal Server Error: " + error.message, 500);
  }
}

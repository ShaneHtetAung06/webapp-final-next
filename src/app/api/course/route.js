//src/app/api/course/route.js

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

/**
 * Helper to authenticate user from cookies, proxy headers, or Authorization header.
 */
async function authenticateUser(req, db) {
  let user = null;

  // 1. Try verifyJWT from cookie
  user = verifyJWT(req);

  // 2. Try Bearer token in Authorization header if not in cookie
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

  // 3. Fallback to headers set by proxy.js if present
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

/**
 * GET /api/course
 *
 * Query Parameters:
 * - search / q: filter by course name or teacher name (case-insensitive regex)
 * - course_name / name / course: filter by course name (case-insensitive regex)
 * - teacher_name / tr_name / teacher: filter by teacher name (case-insensitive regex)
 * - enrolled / my_courses: if true, returns only courses the authenticated student is enrolled in
 *
 * Visibility & Status Rules:
 * - Open: visible to Students and available for enrollment when seats remain.
 * - Close: visible to Students but not available for enrollment.
 * - Cancel: NOT displayed in the Student course list and not available for enrollment.
 * - Teachers can view all courses (including Cancel status).
 */
export async function GET(req) {
  try {
    const client = await getClientPromise();
    const db = client.db(process.env.DB_NAME);

    // Authenticate user (optional for GET)
    const user = await authenticateUser(req, db);

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || url.searchParams.get("q");
    const courseFilter =
      url.searchParams.get("course_name") ||
      url.searchParams.get("name") ||
      url.searchParams.get("course");
    const teacherFilter =
      url.searchParams.get("teacher_name") ||
      url.searchParams.get("tr_name") ||
      url.searchParams.get("teacher");
    const teacherId =
      url.searchParams.get("teacher_id") || url.searchParams.get("teacherId");
    const teacherEmail =
      url.searchParams.get("teacher_email") || url.searchParams.get("teacherEmail");
    const teacherMine =
      url.searchParams.get("my_courses") === "true" ||
      url.searchParams.get("mine") === "true";
    const enrolledOnly =
      url.searchParams.get("enrolled") === "true";

    const filter = {};
    const andConditions = [];

    // 1. Status visibility rules:
    // Students (and unauthenticated guests) see everything EXCEPT 'Cancel' status
    const isTeacher = user?.role === "teacher";
    if (!isTeacher) {
      andConditions.push({
        status: { $nin: ["Cancel", "cancel", "CANCEL"] },
      });
    }

    // 2. Filter by general search term (course name OR teacher name)
    if (search && search.trim() !== "") {
      const trimmedSearch = search.trim();
      andConditions.push({
        $or: [
          { course_name: { $regex: trimmedSearch, $options: "i" } },
          { name: { $regex: trimmedSearch, $options: "i" } },
          { teacher_name: { $regex: trimmedSearch, $options: "i" } },
          { teacher_email: { $regex: trimmedSearch, $options: "i" } },
        ],
      });
    }

    // 3. Filter by specific course name
    if (courseFilter && courseFilter.trim() !== "") {
      const trimmedCourse = courseFilter.trim();
      andConditions.push({
        $or: [
          { course_name: { $regex: trimmedCourse, $options: "i" } },
          { name: { $regex: trimmedCourse, $options: "i" } },
        ],
      });
    }

    // 4. Filter by specific teacher name
    if (teacherFilter && teacherFilter.trim() !== "") {
      const trimmedTeacher = teacherFilter.trim();
      andConditions.push({
        $or: [
          { teacher_name: { $regex: trimmedTeacher, $options: "i" } },
          { teacher_email: { $regex: trimmedTeacher, $options: "i" } },
        ],
      });
    }

    // 5. Filter for teacher's own courses or student's enrolled courses
    if (teacherMine && user) {
      if (user.role === "teacher") {
        andConditions.push({
          $or: [
            { teacher_id: user.id },
            { teacher_email: user.email },
          ],
        });
      } else {
        andConditions.push({
          $or: [
            { "enrolled_students.student_id": user.id },
            { "enrolled_students.id": user.id },
            { "enrolled_students.email": user.email },
            { enrolled_students: user.id },
            { students: user.id },
          ],
        });
      }
    } else if (teacherId) {
      andConditions.push({
        $or: [{ teacher_id: teacherId }, { teacher_email: teacherId }],
      });
    } else if (teacherEmail) {
      andConditions.push({ teacher_email: teacherEmail });
    }

    // 6. Filter for enrolled courses only (if requested by logged-in student)
    if (enrolledOnly && user) {
      andConditions.push({
        $or: [
          { "enrolled_students.student_id": user.id },
          { "enrolled_students.id": user.id },
          { "enrolled_students.email": user.email },
          { enrolled_students: user.id },
          { students: user.id },
        ],
      });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    const courses = await db
      .collection("course")
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();

    // Map courses to include enrollment metadata
    const mappedCourses = courses.map((course) => {
      const enrolledStudents =
        course.enrolled_students || course.students || [];
      const enrolledCount = enrolledStudents.length;
      const maxStudents = Number(
        course.max_student ?? course.max_students ?? 0,
      );
      const seatsAvailable = Math.max(0, maxStudents - enrolledCount);

      // Check if current user is enrolled
      const isEnrolled = user
        ? enrolledStudents.some(
            (s) =>
              s === user.id ||
              s?.student_id === user.id ||
              s?.id === user.id ||
              s?.email === user.email,
          )
        : false;

      const isOpen = String(course.status || "").toLowerCase() === "open";
      const isClosed = String(course.status || "").toLowerCase() === "close";
      const isCancelled =
        String(course.status || "").toLowerCase() === "cancel";

      const canEnroll =
        isOpen &&
        seatsAvailable > 0 &&
        !isEnrolled &&
        (!user || user.role === "student");

      return {
        ...course,
        enrolled_count: enrolledCount,
        seats_available: seatsAvailable,
        is_enrolled: isEnrolled,
        can_enroll: canEnroll,
        is_full: seatsAvailable <= 0,
        is_open: isOpen,
        is_closed: isClosed,
        is_cancelled: isCancelled,
      };
    });

    return successResponse({ courses: mappedCourses }, 200);
  } catch (error) {
    printExceptionLog("Get Courses", error);
    return errorResponse("Internal Server Error: " + error.message, 500);
  }
}

export async function POST(req) {
  try {
    const client = await getClientPromise();
    const db = client.db(process.env.DB_NAME);

    // 1. Authenticate user
    const user = await authenticateUser(req, db);
    if (!user) {
      return errorResponse(
        "Unauthorized: Please log in to create a course",
        401,
      );
    }

    if (user.role !== "teacher") {
      return errorResponse(
        "Forbidden: Only teachers can create new courses",
        403,
      );
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Invalid JSON payload", 400);
    }

    const course_name =
      body.course_name || body.name || body.courseName || body.title;
    const duration = body.duration ?? body.duration_days ?? body.durationDays;
    const rawTopics = body.topics;
    const price = body.price;
    const max_student =
      body.max_student ?? body.max_students ?? body.maxStudent;
    const status = body.status || "Open";

    // Validate course name
    if (!course_name || String(course_name).trim() === "") {
      return errorResponse("Course name is required", 400);
    }

    // Validate duration
    if (
      duration === undefined ||
      duration === null ||
      isNaN(Number(duration)) ||
      Number(duration) <= 0
    ) {
      return errorResponse("Duration (days) must be a positive number", 400);
    }

    // Validate topics
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

    // Validate price
    if (
      price === undefined ||
      price === null ||
      isNaN(Number(price)) ||
      Number(price) < 0
    ) {
      return errorResponse("Price must be a non-negative number", 400);
    }

    // Validate max_student
    if (
      max_student === undefined ||
      max_student === null ||
      isNaN(Number(max_student)) ||
      Number(max_student) <= 0
    ) {
      return errorResponse("Max Student must be a positive number", 400);
    }

    // Validate status (Open / Close / Cancel)
    const validStatuses = ["Open", "Close", "Cancel"];
    const matchedStatus = validStatuses.find(
      (s) => s.toLowerCase() === String(status).trim().toLowerCase(),
    );
    if (!matchedStatus) {
      return errorResponse("Status must be 'Open', 'Close', or 'Cancel'", 400);
    }

    // 4. Create new course document
    const newCourse = {
      course_name: String(course_name).trim(),
      name: String(course_name).trim(),
      duration: Number(duration),
      duration_days: Number(duration),
      topics: topics,
      price: Number(price),
      max_student: Number(max_student),
      max_students: Number(max_student),
      status: matchedStatus,
      enrolled_students: [],
      students: [],
      teacher_id: user.id,
      teacher_name: user.name,
      teacher_email: user.email,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await db.collection("course").insertOne(newCourse);

    return successResponse(
      {
        message: "Course created successfully",
        course: {
          _id: result.insertedId,
          ...newCourse,
          enrolled_count: 0,
          seats_available: Number(max_student),
          is_enrolled: false,
          can_enroll: false,
        },
      },
      201,
    );
  } catch (error) {
    printExceptionLog("Create Course", error);
    return errorResponse("Internal Server Error: " + error.message, 500);
  }
}

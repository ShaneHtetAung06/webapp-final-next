# How to Test the App

## Student Information

- **Student Name:** Shane Htet Aung
- **Student ID:** 6740002

## Test Credentials

- **Teacher Account:**
  - **Email:** `shane@gmail.com`
  - **Password:** `654321`
  - **Role:** Teacher (can create courses, edit/delete created courses, manage enrollments)
- **Student Account:**
  - **Email:** `bob.smith@example.com`
  - **Password:** `654321`
  - **Role:** Student (can view courses, enroll, and drop enrolled courses)
- *Note:* Login supports Email authentication (`bob.smith@example.com` or other existing user emails with password `654321`).

## Prerequisites

- Node.js (v18+ or v20+ recommended)
- npm or yarn package manager
- Internet connectivity for MongoDB Atlas database access (configured in `next-backend/.env`)

## How to Run & Test

### 1. Backend Setup (`next-backend/`)

1. Open a terminal and navigate to the backend directory:
   ```bash
   cd next-backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Verify environment variables in `.env` (already configured with MongoDB connection & JWT secret):
   ```env
   MONGODB_URI=...
   JWT_SECRET=...
   DB_NAME=wab-final
   ```
4. Start the backend development server:
   ```bash
   npm run dev
   ```
   The backend API will run on `http://localhost:3000`.

### 2. Frontend Setup (`react-frontend/`)

1. Open a new terminal and navigate to the frontend directory:
   ```bash
   cd react-frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```
4. Open your browser and navigate to the URL provided in the console (typically `http://localhost:5173`).

---

### 3. Testing Walkthrough

#### A. Testing as a Student
1. **Login**:
   - Go to `http://localhost:5173/login`.
   - Enter Email: `bob.smith@example.com` and Password: `654321`.
   - Click **Login**. You will be redirected to the Course Catalog (`/courses`).
2. **Browse Courses**:
   - Filter, search, and view available courses in the list / grid.
3. **Course Details & Enrollment**:
   - Click on a course to view details at `/courses/:course_id`.
   - Click **Enroll** to register for the course.
   - Verify enrollment status changes to enrolled.
   - Test **Drop Course** to cancel enrollment.
4. **Logout**:
   - Click the Logout button in the header navigation.

#### B. Testing as a Teacher
1. **Login**:
   - Go to `http://localhost:5173/login`.
   - Enter Email: `shane@gmail.com` and Password: `654321`.
   - Click **Login**.
2. **View Teacher Courses**:
   - Navigate to `/teacher/courses` (or My Courses / Teacher dashboard).
   - View courses created by the teacher.
3. **Create Course**:
   - Navigate to `/courses/create`.
   - Fill in course details (title, description, capacity, semester, category, etc.) and submit.
   - Confirm the new course appears in the list.
4. **Edit / Delete Course**:
   - Open the created course and test updating course details or removing the course.

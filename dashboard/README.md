# MeetMind dashboard

The dashboard is the authenticated frontend route at `/dashboard/` when served from the project root. It calls `GET /api/auth/me` with the JWT stored by the login flow. Meeting, task, calendar, and AI content remain empty or explicitly unavailable until their backend APIs exist.

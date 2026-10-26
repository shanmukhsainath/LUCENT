# Account settings

Authenticated users can update their name, preferred language, and timezone
through `PATCH /api/auth/me`. The dashboard exposes these fields through its
Settings control and refreshes the local session profile after a successful
save.

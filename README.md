# Help Desk

Joshua Jordan 10/10/2026

An IT help desk ticketing system with separate user and technician roles. Users report problems; technicians triage, assign, and resolve them.

## Features

- Signup and login (bcrypt password hashing + JWT)
- Role-based access: users see only their own tickets, technicians see all tickets
- Create tickets with a priority (Low, Medium, High, Urgent)
- Ticket status workflow: Open, In Progress, Resolved, Closed
- Technicians can change status and priority and assign tickets to a technician
- Comment thread on each ticket
- Filter by status; urgent tickets sort to the top
- Technician overview: tickets by status and priority, unassigned count, average time to resolve

## Roles

The first account to sign up becomes a technician. Others are users. To make more technicians, set the `TECH_EMAILS` environment variable to a comma-separated list of emails (those people become technicians when they sign up).

## Stack

Node, Express, SQLite (better-sqlite3), plain JavaScript front end.

## Run it locally

```bash
npm install
JWT_SECRET=pick-a-long-random-string npm start
```

Then open http://localhost:3000.

## Database

- `users(id, email, password_hash, role)`
- `tickets(id, user_id, assigned_to, title, description, priority, status, created_at, updated_at)`
- `comments(id, ticket_id, user_id, body, created_at)`

Foreign keys link tickets and comments to users, with cascading deletes. Access rules are enforced on the server, not just hidden in the UI.

## API

| Method | Route | Who | Purpose |
|---|---|---|---|
| POST | /api/signup, /api/login | Anyone | Returns a JWT |
| GET/POST | /api/tickets | Logged in | List (optional `?status=`) / create |
| GET | /api/tickets/:id | Owner or technician | Ticket with comments |
| PUT | /api/tickets/:id | Technician (any field) or owner (close only) | Update |
| POST | /api/tickets/:id/comments | Owner or technician | Add comment |
| GET | /api/stats, /api/technicians | Technician | Overview data / assignee list |

## Next steps

- Email notifications when a ticket is assigned or updated
- Search and pagination
- Deploy on Render (set `JWT_SECRET`; free tier resets the SQLite file on restart)

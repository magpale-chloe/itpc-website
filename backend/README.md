# Backend database setup

The member roster and duty logs are stored in PostgreSQL. The backend creates the
required tables and indexes automatically when it starts. `DATABASE_URL` is
required; the server fails to start if it is missing or cannot connect.

## Local development

1. Create a PostgreSQL database named `itpc_photobooth` (or use another name).
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to your database's
   connection URL, along with the Executive Board login credentials.
3. Run `npm start` from the `backend` directory.

For a hosted database, use its connection URL in `DATABASE_URL`. Do not commit
real connection URLs or credentials.

## Render deployment

1. Create a PostgreSQL database in the Render dashboard.
2. Open the backend web service's **Environment** settings.
3. Add `DATABASE_URL` using the database's internal connection URL when the
   database and service are in the same Render region.
4. Keep `ITPC_USERNAME` and `ITPC_PASSWORD` configured for Executive Board login.
   Set `COMMITTEE_USERNAME` and `COMMITTEE_PASSWORD` to enable the view-only
   Committee login, which can see everyone's duty hours but cannot edit them.
5. Redeploy or restart the backend service.

Roster edits and attendance records persist in this database across backend
restarts and deployments. Removing a roster member retains historical duty-log
entries, which contain a snapshot of the member and card details at scan time.

Run the backend tests with `npm test`. They include a PostgreSQL-compatible
database test for schema setup and persistence across store instances.

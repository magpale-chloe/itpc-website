# Backend database setup

The member roster and duty logs are stored in MongoDB, in the `students` and
`duty_logs` collections. The backend creates the required indexes automatically
when it starts. `MONGODB_URI` is required; the server fails to start if it is
missing or cannot connect.

The database is taken from the path of `MONGODB_URI`
(`.../itpc_photobooth`). Set `MONGODB_DB_NAME` to override it. Any MongoDB
server works: a local standalone `mongod`, a replica set, or MongoDB Atlas.

## Local development

1. Install and start MongoDB Community Server, or create a free MongoDB Atlas
   cluster.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` (for example
   `mongodb://localhost:27017/itpc_photobooth`), along with the Executive Board
   login credentials.
3. Run `npm start` from the `backend` directory.

Do not commit real connection strings or credentials.

## Render deployment (with MongoDB Atlas)

1. Create a cluster in MongoDB Atlas and a database user for the backend.
2. Under **Network Access**, allow connections from your Render service
   (Render's outbound IPs, or `0.0.0.0/0` if you rely on the database password).
3. Open the backend web service's **Environment** settings on Render and add
   `MONGODB_URI` with the Atlas connection string, including the database name,
   e.g. `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/itpc_photobooth`.
4. Keep `ITPC_USERNAME` and `ITPC_PASSWORD` configured for Executive Board login.
   Set `COMMITTEE_USERNAME` and `COMMITTEE_PASSWORD` to enable the view-only
   Committee login, which can see everyone's duty hours but cannot edit them.
5. Redeploy or restart the backend service.

Roster edits and attendance records persist in this database across backend
restarts and deployments. Removing a roster member retains historical duty-log
entries, which contain a snapshot of the member and card details at scan time.

Run the backend tests with `npm test`. The store tests start a temporary
in-memory MongoDB server (the binary is downloaded on the first run).

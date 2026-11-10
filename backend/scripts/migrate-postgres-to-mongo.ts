// One-time copy of the roster and duty logs from the old PostgreSQL database into MongoDB.
//
// Usage (from the backend directory):
//   npm install --no-save pg
//   node --env-file=.env --import tsx scripts/migrate-postgres-to-mongo.ts
//
// Needs OLD_DATABASE_URL (Render PostgreSQL "External Database URL") and MONGODB_URI in .env.
// It is safe to run more than once: documents are upserted by their original IDs.
import { MongoClient, type AnyBulkWriteOperation, type Document } from 'mongodb';
import pg from 'pg';
import { MongoDutyLogStore } from '../duty-log-store.ts';

const oldUrl = process.env.OLD_DATABASE_URL?.trim();
const mongoUri = process.env.MONGODB_URI?.trim();
if (!oldUrl || !mongoUri) {
  console.error('Set OLD_DATABASE_URL and MONGODB_URI in backend/.env before running this script.');
  process.exit(1);
}
const dbName = process.env.MONGODB_DB_NAME || undefined;

const toDate = (value: unknown): Date | null => (value == null ? null : new Date(value as string | Date));
const toNumber = (value: unknown): number | null => (value == null ? null : Number(value));

const postgres = new pg.Client({
  connectionString: oldUrl,
  // Render's external connections require SSL.
  ssl: oldUrl.includes('localhost') ? undefined : { rejectUnauthorized: false }
});
const mongo = new MongoClient(mongoUri);

try {
  console.log('Connecting to PostgreSQL...');
  await postgres.connect();
  const students = (await postgres.query('SELECT * FROM students')).rows;
  const logs = (await postgres.query('SELECT * FROM duty_logs')).rows;
  console.log(`Found ${students.length} students and ${logs.length} duty logs in PostgreSQL.`);

  console.log('Connecting to MongoDB and creating indexes...');
  const store = new MongoDutyLogStore(mongoUri, { dbName });
  await store.initialize();
  await store.close();
  await mongo.connect();
  const db = mongo.db(dbName);

  const studentOps: AnyBulkWriteOperation<Document>[] = students.map((row) => {
    const document = {
      _id: row.id,
      name: row.name,
      rfid_uid: row.rfid_uid,
      rfid_uid_lower: String(row.rfid_uid).toLowerCase(),
      position: row.position ?? '',
      member_type: row.member_type ?? 'OFFICER',
      photo_url: row.photo_url ?? '',
      created_at: toDate(row.created_at) ?? new Date(),
      updated_at: toDate(row.updated_at) ?? new Date()
    };
    return { replaceOne: { filter: { _id: row.id }, replacement: document, upsert: true } };
  });

  const logOps: AnyBulkWriteOperation<Document>[] = logs.map((row) => {
    const document = {
      _id: row.id,
      student_id: row.student_id,
      student_name: row.student_name,
      rfid_uid: row.rfid_uid ?? '',
      position: row.position ?? '',
      is_non_member: Boolean(row.is_non_member),
      clock_in_time: toDate(row.clock_in_time),
      clock_out_time: toDate(row.clock_out_time),
      status: row.status,
      total_duty_hours: toNumber(row.total_duty_hours),
      scanned_by_officer_id: row.scanned_by_officer_id ?? null,
      scanned_by_officer_name: row.scanned_by_officer_name ?? null,
      scanned_by_clock_out_officer_id: row.scanned_by_clock_out_officer_id ?? null,
      scanned_by_clock_out_officer_name: row.scanned_by_clock_out_officer_name ?? null,
      created_at: toDate(row.created_at) ?? new Date(),
      updated_at: toDate(row.updated_at) ?? new Date()
    };
    return { replaceOne: { filter: { _id: row.id }, replacement: document, upsert: true } };
  });

  if (studentOps.length) {
    await db.collection('students').bulkWrite(studentOps, { ordered: false });
  }
  if (logOps.length) {
    await db.collection('duty_logs').bulkWrite(logOps, { ordered: false });
  }

  const [mongoStudents, mongoLogs] = await Promise.all([
    db.collection('students').countDocuments(),
    db.collection('duty_logs').countDocuments()
  ]);
  console.log(`MongoDB now has ${mongoStudents} students and ${mongoLogs} duty logs.`);
  if (mongoStudents < students.length || mongoLogs < logs.length) {
    console.error('Warning: MongoDB has fewer documents than PostgreSQL. Check the output above.');
    process.exitCode = 1;
  } else {
    console.log('Migration complete.');
  }
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([postgres.end(), mongo.close()]);
}

import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  DutyLogStore,
  isMemberType,
  MemberType,
  MemoryDutyLogStore,
  PostgresDutyLogStore,
  StoreError,
  StudentInput
} from './duty-log-store.ts';

const PORT = Number(process.env.PORT) || 3000;
const photoStore = new Map<string, { data: Buffer; expiresAt: number }>();
const PHOTO_LIFETIME_MS = 30 * 60 * 1000;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const MAX_MEMBER_PHOTO_LENGTH = 1_500_000;
const MAX_LOG_RANGE_MS = 62 * 24 * 60 * 60 * 1000;

type LoginRole = 'executive';
type AuthUser = { username: string; role: LoginRole };
type StoredCredential = AuthUser & { password: string };
type Session = AuthUser & { expiresAt: number };
const credentials: StoredCredential[] = [
  { username: process.env.ITPC_USERNAME || '', password: process.env.ITPC_PASSWORD || '', role: 'executive' }
];

export function createApp(options: { credentials?: StoredCredential[]; store?: DutyLogStore } = {}) {
  const sessions = new Map<string, Session>();
  const appCredentials = options.credentials ?? credentials;
  const store = options.store ?? new MemoryDutyLogStore();
  const app = express();

  app.use(express.json({ limit: '12mb' }));
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'POST, GET, PATCH, DELETE, OPTIONS');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/', (_req, res) => {
    res.send('Photobooth backend is running!');
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password, role } = req.body as {
      username?: unknown;
      password?: unknown;
      role?: unknown;
    };

    if (typeof username !== 'string' || typeof password !== 'string' || !isLoginRole(role)) {
      res.status(400).json({ error: 'Username, password, and account type are required' });
      return;
    }

    const credential = appCredentials.find((entry) =>
      entry.username === username &&
      entry.password &&
      sameSecret(entry.password, password) &&
      entry.role === role
    );

    if (!credential) {
      res.status(401).json({ error: 'Invalid account type or credentials' });
      return;
    }

    const token = randomUUID();
    sessions.set(token, {
      username: credential.username,
      role: credential.role,
      expiresAt: Date.now() + SESSION_LIFETIME_MS
    });
    res.json({
      token,
      user: { username: credential.username, role: credential.role },
      expiresAt: Date.now() + SESSION_LIFETIME_MS
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    if (token) {
      sessions.delete(token);
    }
    res.sendStatus(204);
  });

  app.get('/api/auth/me', (req, res) => {
    const session = getSession(req.headers.authorization, sessions);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.json({ user: { username: session.username, role: session.role } });
  });

  app.get('/api/students', async (_req, res) => {
    res.json(await store.listStudents());
  });

  app.post('/api/students', async (req, res) => {
    const session = getSession(req.headers.authorization, sessions);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (session.role !== 'executive') {
      res.status(403).json({ error: 'Executive Board access is required to add to the roster' });
      return;
    }

    const input = parseStudentInput(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }

    const student = await store.createStudent(input);
    res.status(201).json(student);
  });

  app.patch('/api/students/:id', async (req, res) => {
    const session = getSession(req.headers.authorization, sessions);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (session.role !== 'executive') {
      res.status(403).json({ error: 'Executive Board access is required to edit the roster' });
      return;
    }

    const input = parseStudentInput(req.body);
    if (typeof input === 'string') {
      res.status(400).json({ error: input });
      return;
    }

    res.json(await store.updateStudent(req.params.id, input));
  });

  app.delete('/api/students/:id', async (req, res) => {
    const session = getSession(req.headers.authorization, sessions);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (session.role !== 'executive') {
      res.status(403).json({ error: 'Executive Board access is required to remove roster members' });
      return;
    }

    await store.deleteStudent(req.params.id);
    res.sendStatus(204);
  });

  app.post('/api/photos', (req, res) => {
    const image = req.body?.image;
    const match = typeof image === 'string' ? image.match(/^data:image\/png;base64,(.+)$/) : null;

    if (!match) {
      res.status(400).json({ error: 'A PNG data URL is required' });
      return;
    }

    const id = randomUUID();
    photoStore.set(id, {
      data: Buffer.from(match[1], 'base64'),
      expiresAt: Date.now() + PHOTO_LIFETIME_MS
    });

    res.json({ url: `${req.protocol}://${req.get('host')}/api/photos/${id}` });
  });

  app.get('/api/photos/:id', (req, res) => {
    const photo = photoStore.get(req.params.id);

    if (!photo || photo.expiresAt < Date.now()) {
      photoStore.delete(req.params.id);
      res.status(404).send('Photo not found or expired');
      return;
    }

    res.type('png').set({
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="itpc-photobooth.png"'
    }).send(photo.data);
  });

  app.post('/api/duty-log', async (req, res) => {
    const identifier = extractCardIdentifier(req.body);
    const selectedOfficerId = req.body?.officerId;
    if (selectedOfficerId !== undefined && (typeof selectedOfficerId !== 'string' || !selectedOfficerId.trim())) {
      res.status(400).json({ error: 'A valid clocking officer is required' });
      return;
    }

    if (typeof identifier !== 'string' || identifier.trim() === '') {
      res.status(400).json({ error: 'Card UID is required' });
      return;
    }

    const result = await store.recordScan(
      identifier,
      typeof selectedOfficerId === 'string' ? selectedOfficerId : undefined,
      extractBasicAuthIdentity(req.headers.authorization)
    );
    res.json(result);
  });

  app.post('/api/duty-log/manual', async (req, res) => {
    const session = getSession(req.headers.authorization, sessions);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (session.role !== 'executive') {
      res.status(403).json({ error: 'Executive Board access is required to add a manual duty log' });
      return;
    }

    const { name, officerId } = req.body as { name?: unknown; officerId?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    if (typeof officerId !== 'string' || !officerId.trim()) {
      res.status(400).json({ error: 'A valid clocking officer is required' });
      return;
    }

    res.status(201).json(await store.createManualLog(name.trim(), officerId.trim()));
  });

  app.patch('/api/duty-log/:id/clock-out', async (req, res) => {
    const session = getSession(req.headers.authorization, sessions);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (session.role !== 'executive') {
      res.status(403).json({ error: 'Executive Board access is required to manually clock out a duty log' });
      return;
    }

    res.json(await store.clockOutLog(req.params.id));
  });

  app.delete('/api/duty-log/:id', async (req, res) => {
    const session = getSession(req.headers.authorization, sessions);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (session.role !== 'executive') {
      res.status(403).json({ error: 'Executive Board access is required to delete a duty log' });
      return;
    }

    await store.deleteLog(req.params.id);
    res.sendStatus(204);
  });

  app.get('/api/duty-log/recent', async (_req, res) => {
    const entries = await store.listRecentLogs();
    res.json(entries.map((entry) => ({
      ...entry,
      action: entry.status === 'ACTIVE' ? 'CLOCK_IN' : 'CLOCK_OUT',
      timestamp: entry.clockOutTime ?? entry.clockInTime
    })));
  });

  app.get('/api/duty-log', async (req, res) => {
    const from = new Date(typeof req.query.from === 'string' ? req.query.from : '');
    const to = new Date(typeof req.query.to === 'string' ? req.query.to : '');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      res.status(400).json({ error: 'Valid "from" and "to" ISO dates are required, with "from" before "to"' });
      return;
    }
    if (to.getTime() - from.getTime() > MAX_LOG_RANGE_MS) {
      res.status(400).json({ error: 'The requested range cannot be longer than 62 days' });
      return;
    }

    res.json(await store.listLogsBetween(from, to));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof StoreError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error('Request failed:', error);
    res.status(500).json({ error: 'The request could not be completed because of a server error.' });
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = new PostgresDutyLogStore(process.env.DATABASE_URL ?? '');
  void store.initialize().then(() => {
    const server = createApp({ store }).listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
    const shutdown = () => {
      server.close((error) => {
        if (error) {
          console.error('Failed to close HTTP server:', error);
          process.exitCode = 1;
        }
        void store.close().catch((closeError: unknown) => {
          console.error('Failed to close PostgreSQL pool:', closeError);
          process.exitCode = 1;
        });
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error: unknown) => {
    console.error('Unable to initialize PostgreSQL. Check DATABASE_URL and database availability:', error);
    process.exitCode = 1;
  });
}

// Returns the validated roster input, or an error message for a 400 response.
function parseStudentInput(body: unknown): StudentInput | string {
  const {
    name,
    rfid_uid: rfidUid,
    position,
    member_type: memberType,
    photo_url: photoUrl
  } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof name !== 'string' || !name.trim() ||
    typeof rfidUid !== 'string' || !rfidUid.trim() ||
    typeof position !== 'string'
  ) {
    return 'Name, RFID card ID, and position are required';
  }
  if (memberType !== undefined && !isMemberType(memberType)) {
    return 'Member type must be Officer, Junior Officer, or Committee';
  }
  if (photoUrl !== undefined && (
    typeof photoUrl !== 'string' ||
    (photoUrl !== '' && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photoUrl))
  )) {
    return 'Member photo must be a PNG, JPEG, or WebP image';
  }
  if (typeof photoUrl === 'string' && photoUrl.length > MAX_MEMBER_PHOTO_LENGTH) {
    return 'Member photo is too large. Choose a smaller image.';
  }

  return {
    name: name.trim(),
    rfid_uid: rfidUid.trim(),
    position: position.trim(),
    member_type: memberType as MemberType | undefined,
    photo_url: photoUrl as string | undefined
  };
}

function isLoginRole(value: unknown): value is LoginRole {
  return value === 'executive';
}

function sameSecret(expected: string, actual: string): boolean {
  const expectedHash = createHash('sha256').update(expected).digest();
  const actualHash = createHash('sha256').update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

function getBearerToken(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

function getSession(header: string | undefined, sessions: Map<string, Session>): Session | null {
  const token = getBearerToken(header);
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) {
      sessions.delete(token);
    }
    return null;
  }
  return session;
}

function extractCardIdentifier(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const payload = body as Record<string, unknown>;
  const identifier = payload.identifier ?? payload.tag_id ?? payload.rfid_uid ?? payload.card_id;

  return typeof identifier === 'string' ? identifier.trim() : null;
}

function extractBasicAuthIdentity(header: string | undefined): { id: string; name: string } | null {
  if (!header || !header.startsWith('Basic ')) {
    return null;
  }

  const base64 = header.slice(6).trim();
  try {
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      return null;
    }

    const id = decoded.slice(0, separatorIndex).trim();
    if (!id) {
      return null;
    }

    return { id, name: id };
  } catch {
    return null;
  }
}
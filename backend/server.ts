import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const photoStore = new Map<string, { data: Buffer; expiresAt: number }>();
const PHOTO_LIFETIME_MS = 30 * 60 * 1000;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
type LoginRole = 'executive';
type AuthUser = { username: string; role: LoginRole };
type StoredCredential = AuthUser & { password: string };
type Session = AuthUser & { expiresAt: number };

const credentials: StoredCredential[] = [
  { username: process.env.ITPC_USERNAME || '', password: process.env.ITPC_PASSWORD || '', role: 'executive' }
];
const sessions = new Map<string, Session>();

app.use(express.json({ limit: '12mb' }));
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/', (req, res) => {
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

  const credential = credentials.find((entry) =>
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
  const session = getSession(req.headers.authorization);
  if (!session) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  res.json({ user: { username: session.username, role: session.role } });
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

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

function getSession(header: string | undefined): Session | null {
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
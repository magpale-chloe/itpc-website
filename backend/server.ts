import express from 'express';
import { randomUUID } from 'node:crypto';

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const photoStore = new Map<string, { data: Buffer; expiresAt: number }>();
const PHOTO_LIFETIME_MS = 30 * 60 * 1000;

app.use(express.json({ limit: '12mb' }));
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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
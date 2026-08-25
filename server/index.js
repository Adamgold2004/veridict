require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const { readSession } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(readSession);

// ---- API ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/formats', require('./routes/formats'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/rounds', require('./routes/rounds').router);
app.use('/api/ballots', require('./routes/ballots'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, engine: db.isPg ? 'postgres' : 'sqlite' });
});

// ---- static frontend ----
app.use(express.static(path.join(__dirname, '..', 'public')));

// Clean URLs: /tab serves public/tab.html
app.get('/:page', (req, res, next) => {
  const file = path.join(__dirname, '..', 'public', `${req.params.page}.html`);
  res.sendFile(file, err => err && next());
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'No such endpoint.' });
  }
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

// Errors return JSON on the API so the frontend can always parse a reply.
app.use((err, req, res, _next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
  res.status(500).send('Something went wrong.');
});

app.listen(PORT, () => {
  console.log(`\n  Veridict running at http://localhost:${PORT}`);
  console.log(`  Database: ${db.isPg ? 'Postgres' : 'SQLite (db/veridict.sqlite)'}\n`);
});

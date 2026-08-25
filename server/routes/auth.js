const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('../db');
const { setSession, clearSession, requireAuth } = require('../auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password, display_name, institution, role } = req.body || {};

  if (!email || !password || !display_name) {
    return res.status(400).json({ error: 'Email, password, and name are all required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const taken = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (taken) {
    return res.status(409).json({ error: 'An account already uses that email.' });
  }

  // Anyone may register as a debater or judge. Admin is granted, not claimed.
  const safeRole = ['debater', 'judge'].includes(role) ? role : 'debater';

  const user = {
    id: randomUUID(),
    email: email.toLowerCase(),
    display_name,
    role: safeRole,
  };

  await db.run(
    `INSERT INTO users (id,email,password_hash,display_name,institution,role,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [user.id, user.email, bcrypt.hashSync(password, 10), display_name,
     institution || null, safeRole, new Date().toISOString()]
  );

  setSession(res, user);
  res.status(201).json({ user });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }

  const row = await db.get('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    // Same message either way — don't reveal which addresses have accounts.
    return res.status(401).json({ error: 'That email and password do not match.' });
  }

  setSession(res, row);
  res.json({
    user: {
      id: row.id, email: row.email,
      display_name: row.display_name, role: row.role,
    },
  });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const row = await db.get(
    'SELECT id,email,display_name,institution,role FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!row) return res.status(401).json({ error: 'Session no longer valid.' });
  res.json({ user: row });
});

module.exports = router;

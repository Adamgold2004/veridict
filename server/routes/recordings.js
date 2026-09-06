const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

const STORE = process.env.RECORDING_DIR || path.join(__dirname, '..', '..', 'storage');
fs.mkdirSync(STORE, { recursive: true });

// How long audio is kept. Set RETENTION_DAYS=0 to keep indefinitely.
const RETENTION_DAYS = process.env.RETENTION_DAYS === undefined
  ? 180 : Number(process.env.RETENTION_DAYS);

/* ------------------------------------------------------------------
   Consent
------------------------------------------------------------------ */

/** Consent state for every speaker in a round, so the recorder knows
    whose microphone it may open before the round starts. */
router.get('/consent/round/:roundId', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT u.id, u.display_name,
            COALESCE(rc.status, 'pending') AS status,
            COALESCE(rc.is_minor, 0)       AS is_minor
     FROM round_teams rt
     JOIN team_members tm ON tm.team_id = rt.team_id
     JOIN users u         ON u.id = tm.user_id
     LEFT JOIN recording_consent rc ON rc.user_id = u.id
     WHERE rt.round_id = ?`,
    [req.params.roundId]
  );
  res.json({ consent: rows });
});

router.get('/consent', requireRole('admin'), async (_req, res) => {
  const rows = await db.all(
    `SELECT u.id, u.display_name, u.email, u.institution,
            COALESCE(rc.status,'pending') AS status,
            COALESCE(rc.is_minor,0)       AS is_minor,
            rc.guardian_name, rc.guardian_email, rc.updated_at
     FROM users u
     LEFT JOIN recording_consent rc ON rc.user_id = u.id
     WHERE u.role = 'debater'
     ORDER BY u.display_name`
  );
  res.json({ consent: rows });
});

router.put('/consent/:userId', requireRole('admin'), async (req, res) => {
  const { status, is_minor, guardian_name, guardian_email, note } = req.body || {};
  if (!['granted', 'withheld', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Status must be granted, withheld, or pending.' });
  }

  // An under-18 needs a named guardian on record before consent counts.
  if (status === 'granted' && is_minor && !guardian_name) {
    return res.status(400).json({
      error: 'Record the name of the parent or guardian who gave consent.',
    });
  }

  const existing = await db.get(
    'SELECT user_id FROM recording_consent WHERE user_id = ?', [req.params.userId]
  );
  const args = [status, is_minor ? 1 : 0, guardian_name || null,
                guardian_email || null, req.user.id, note || null,
                new Date().toISOString()];

  if (existing) {
    await db.run(
      `UPDATE recording_consent SET status=?, is_minor=?, guardian_name=?,
              guardian_email=?, collected_by=?, note=?, updated_at=?
       WHERE user_id=?`,
      [...args, req.params.userId]
    );
  } else {
    await db.run(
      `INSERT INTO recording_consent
       (status,is_minor,guardian_name,guardian_email,collected_by,note,updated_at,user_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [...args, req.params.userId]
    );
  }

  // Withdrawing consent removes what was already captured. Consent that
  // can't be withdrawn isn't consent.
  if (status !== 'granted') {
    const gone = await db.all(
      'SELECT id, filename FROM recordings WHERE speaker_id = ?', [req.params.userId]
    );
    for (const r of gone) {
      fs.promises.unlink(path.join(STORE, r.filename)).catch(() => {});
    }
    await db.run('DELETE FROM recordings WHERE speaker_id = ?', [req.params.userId]);
    return res.json({ ok: true, deleted: gone.length });
  }

  res.json({ ok: true, deleted: 0 });
});

/* ------------------------------------------------------------------
   Upload
------------------------------------------------------------------ */

/** Raw audio body — avoids a multipart dependency for a single file. */
const rawAudio = express.raw({
  type: ['audio/webm', 'audio/ogg', 'audio/mp4', 'application/octet-stream'],
  limit: process.env.MAX_RECORDING_MB ? `${process.env.MAX_RECORDING_MB}mb` : '30mb',
});

router.post('/round/:roundId/:position', requireAuth, rawAudio, async (req, res) => {
  const { roundId, position } = req.params;

  const round = await db.get('SELECT * FROM rounds WHERE id = ?', [roundId]);
  if (!round) return res.status(404).json({ error: 'No such round.' });

  const isJudge = await db.get(
    'SELECT 1 AS ok FROM round_judges WHERE round_id = ? AND user_id = ?',
    [roundId, req.user.id]
  );
  if (!isJudge && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only judges on this round can record it.' });
  }

  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'No audio arrived.' });
  }

  // Work out who was speaking in this slot.
  const speech = await db.get(
    `SELECT fs.* FROM format_speeches fs
     JOIN tournaments t ON t.format_id = fs.format_id
     JOIN rounds r ON r.tournament_id = t.id
     WHERE r.id = ? AND fs.position = ?`,
    [roundId, position]
  );
  if (!speech) return res.status(400).json({ error: 'That speech is not in this format.' });

  const speaker = await db.get(
    `SELECT u.id, u.display_name FROM round_teams rt
     JOIN team_members tm ON tm.team_id = rt.team_id
     JOIN users u ON u.id = tm.user_id
     WHERE rt.round_id = ? AND rt.team_slot = ? AND tm.speaker_index = ?`,
    [roundId, speech.team_slot, speech.speaker_index]
  );

  // The gate: no consent on file, no recording stored.
  if (speaker) {
    const consent = await db.get(
      'SELECT status FROM recording_consent WHERE user_id = ?', [speaker.id]
    );
    if (!consent || consent.status !== 'granted') {
      return res.status(403).json({
        error: `${speaker.display_name} has not consented to being recorded.`,
        code: 'no_consent',
      });
    }
  }

  const id = randomUUID();
  const ext = (req.headers['content-type'] || '').includes('ogg') ? 'ogg'
            : (req.headers['content-type'] || '').includes('mp4') ? 'm4a' : 'webm';
  const filename = `${id}.${ext}`;

  await fs.promises.writeFile(path.join(STORE, filename), req.body);

  const expires = RETENTION_DAYS > 0
    ? new Date(Date.now() + RETENTION_DAYS * 864e5).toISOString()
    : null;

  await db.run(
    `INSERT INTO recordings
     (id,round_id,speech_position,speaker_id,recorded_by,filename,mime_type,bytes,duration_sec,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, roundId, Number(position), speaker?.id || null, req.user.id, filename,
     req.headers['content-type'] || 'audio/webm', req.body.length,
     Number(req.headers['x-duration-sec']) || null,
     new Date().toISOString(), expires]
  );

  res.status(201).json({
    id, bytes: req.body.length,
    speaker: speaker?.display_name || null,
    expires_at: expires,
  });
});

/* ------------------------------------------------------------------
   Listing and playback
------------------------------------------------------------------ */

router.get('/round/:roundId', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT r.id, r.speech_position, r.speaker_id, r.bytes, r.duration_sec,
            r.created_at, r.expires_at, u.display_name AS speaker_name
     FROM recordings r
     LEFT JOIN users u ON u.id = r.speaker_id
     WHERE r.round_id = ? ORDER BY r.speech_position`,
    [req.params.roundId]
  );
  res.json({ recordings: rows });
});

/** A debater's own recordings across the season. */
router.get('/mine', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT rec.id, rec.speech_position, rec.duration_sec, rec.created_at,
            rec.expires_at, r.motion, r.sequence, r.id AS round_id,
            t.name AS tournament_name
     FROM recordings rec
     JOIN rounds r      ON r.id = rec.round_id
     JOIN tournaments t ON t.id = r.tournament_id
     WHERE rec.speaker_id = ?
     ORDER BY rec.created_at DESC`,
    [req.user.id]
  );
  res.json({ recordings: rows });
});

/** Audio is served through the app, never as a public file, so every
    request is checked against who is allowed to hear it. */
router.get('/:id/audio', requireAuth, async (req, res) => {
  const rec = await db.get('SELECT * FROM recordings WHERE id = ?', [req.params.id]);
  if (!rec) return res.status(404).json({ error: 'No such recording.' });

  const isSpeaker = rec.speaker_id === req.user.id;
  const isPanel = await db.get(
    'SELECT 1 AS ok FROM round_judges WHERE round_id = ? AND user_id = ?',
    [rec.round_id, req.user.id]
  );
  if (!isSpeaker && !isPanel && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You cannot listen to this recording.' });
  }

  const file = path.join(STORE, rec.filename);
  if (!fs.existsSync(file)) {
    return res.status(410).json({ error: 'This recording has been deleted.' });
  }

  const stat = fs.statSync(file);
  const range = req.headers.range;

  // Range support so players can seek without downloading the whole clip.
  if (range) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : stat.size - 1;
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': rec.mime_type,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.set({
    'Content-Type': rec.mime_type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(file).pipe(res);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const rec = await db.get('SELECT * FROM recordings WHERE id = ?', [req.params.id]);
  if (!rec) return res.status(404).json({ error: 'No such recording.' });

  // A speaker can always delete their own audio.
  if (rec.speaker_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You cannot delete this recording.' });
  }

  await fs.promises.unlink(path.join(STORE, rec.filename)).catch(() => {});
  await db.run('DELETE FROM recordings WHERE id = ?', [rec.id]);
  res.json({ ok: true });
});

/** Storage in use, so an organiser can see it before a free tier fills. */
router.get('/usage', requireRole('admin'), async (_req, res) => {
  const row = await db.get(
    'SELECT COUNT(*) AS files, COALESCE(SUM(bytes),0) AS total FROM recordings'
  );
  res.json({
    files: Number(row.files),
    bytes: Number(row.total),
    retention_days: RETENTION_DAYS,
  });
});

module.exports = router;

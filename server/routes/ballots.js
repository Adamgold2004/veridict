const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

/**
 * Fetch the signed-in judge's ballot for a round, creating it on first
 * open. A ballot belongs to exactly one judge; there is no endpoint
 * anywhere that returns someone else's open ballot.
 */
router.get('/round/:roundId', requireAuth, async (req, res) => {
  const round = await db.get('SELECT * FROM rounds WHERE id = ?', [req.params.roundId]);
  if (!round) return res.status(404).json({ error: 'No such round.' });

  const assigned = await db.get(
    'SELECT is_chair FROM round_judges WHERE round_id = ? AND user_id = ?',
    [round.id, req.user.id]
  );
  if (!assigned && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You are not judging this round.' });
  }

  let ballot = await db.get(
    'SELECT * FROM ballots WHERE round_id = ? AND judge_id = ?',
    [round.id, req.user.id]
  );

  if (!ballot) {
    const bid = randomUUID();
    await db.run(
      'INSERT INTO ballots (id,round_id,judge_id,status) VALUES (?,?,?,?)',
      [bid, round.id, req.user.id, 'open']
    );
    ballot = await db.get('SELECT * FROM ballots WHERE id = ?', [bid]);
  }

  const scores = await db.all(
    'SELECT criterion_id, speech_position, score FROM ballot_scores WHERE ballot_id = ?',
    [ballot.id]
  );
  const rankings = await db.all(
    'SELECT team_id, rank FROM ballot_rankings WHERE ballot_id = ?',
    [ballot.id]
  );
  const feedback = await db.all(
    'SELECT speech_position, strengths, improvements FROM speech_feedback WHERE ballot_id = ?',
    [ballot.id]
  );

  res.json({
    ballot: { ...ballot, is_chair: assigned?.is_chair === 1 },
    scores, rankings, feedback,
  });
});

/** Autosave. Called as the judge moves sliders, so nothing is lost. */
router.put('/:id/scores', requireAuth, async (req, res) => {
  const ballot = await db.get('SELECT * FROM ballots WHERE id = ?', [req.params.id]);
  if (!ballot) return res.status(404).json({ error: 'No such ballot.' });
  if (ballot.judge_id !== req.user.id) {
    return res.status(403).json({ error: 'That is not your ballot.' });
  }
  if (ballot.status !== 'open') {
    return res.status(409).json({ error: 'This ballot is already submitted.' });
  }

  const { speech_position, scores } = req.body || {};
  if (!speech_position || typeof scores !== 'object') {
    return res.status(400).json({ error: 'Send a speech position and its scores.' });
  }

  // Validate every score against the criterion's own range before saving.
  for (const [criterionId, value] of Object.entries(scores)) {
    const crit = await db.get('SELECT * FROM format_criteria WHERE id = ?', [criterionId]);
    if (!crit) continue;
    const v = Number(value);
    if (Number.isNaN(v) || v < crit.score_min || v > crit.score_max) {
      return res.status(400).json({
        error: `${crit.name} must be between ${crit.score_min} and ${crit.score_max}.`,
      });
    }

    const existing = await db.get(
      'SELECT id FROM ballot_scores WHERE ballot_id = ? AND criterion_id = ? AND speech_position = ?',
      [ballot.id, criterionId, speech_position]
    );
    if (existing) {
      await db.run('UPDATE ballot_scores SET score = ? WHERE id = ?', [v, existing.id]);
    } else {
      await db.run(
        `INSERT INTO ballot_scores (id,ballot_id,criterion_id,speech_position,score)
         VALUES (?,?,?,?,?)`,
        [randomUUID(), ballot.id, criterionId, speech_position, v]
      );
    }
  }

  res.json({ ok: true, saved_at: new Date().toISOString() });
});

router.put('/:id/rankings', requireAuth, async (req, res) => {
  const ballot = await db.get('SELECT * FROM ballots WHERE id = ?', [req.params.id]);
  if (!ballot) return res.status(404).json({ error: 'No such ballot.' });
  if (ballot.judge_id !== req.user.id) {
    return res.status(403).json({ error: 'That is not your ballot.' });
  }
  if (ballot.status !== 'open') {
    return res.status(409).json({ error: 'This ballot is already submitted.' });
  }

  const { rankings } = req.body || {};
  if (!Array.isArray(rankings)) {
    return res.status(400).json({ error: 'Send the rankings as a list.' });
  }

  // A rank is exclusive — two teams cannot share second place.
  const seen = new Set();
  for (const r of rankings) {
    if (seen.has(r.rank)) {
      return res.status(400).json({ error: `Two teams are both ranked ${r.rank}.` });
    }
    seen.add(r.rank);
  }

  await db.run('DELETE FROM ballot_rankings WHERE ballot_id = ?', [ballot.id]);
  for (const r of rankings) {
    await db.run(
      'INSERT INTO ballot_rankings (ballot_id,team_id,rank) VALUES (?,?,?)',
      [ballot.id, r.team_id, r.rank]
    );
  }

  res.json({ ok: true });
});

router.put('/:id/reasoning', requireAuth, async (req, res) => {
  const ballot = await db.get('SELECT * FROM ballots WHERE id = ?', [req.params.id]);
  if (!ballot || ballot.judge_id !== req.user.id) {
    return res.status(403).json({ error: 'That is not your ballot.' });
  }
  await db.run('UPDATE ballots SET reasoning = ? WHERE id = ?',
    [req.body?.reasoning || null, ballot.id]);
  res.json({ ok: true });
});

router.put('/:id/feedback', requireAuth, async (req, res) => {
  const ballot = await db.get('SELECT * FROM ballots WHERE id = ?', [req.params.id]);
  if (!ballot || ballot.judge_id !== req.user.id) {
    return res.status(403).json({ error: 'That is not your ballot.' });
  }

  const { speech_position, strengths, improvements } = req.body || {};
  if (!speech_position) return res.status(400).json({ error: 'Missing speech position.' });

  const existing = await db.get(
    'SELECT id FROM speech_feedback WHERE ballot_id = ? AND speech_position = ?',
    [ballot.id, speech_position]
  );
  if (existing) {
    await db.run(
      'UPDATE speech_feedback SET strengths = ?, improvements = ? WHERE id = ?',
      [strengths || null, improvements || null, existing.id]
    );
  } else {
    await db.run(
      `INSERT INTO speech_feedback (id,ballot_id,speech_position,strengths,improvements)
       VALUES (?,?,?,?,?)`,
      [randomUUID(), ballot.id, speech_position, strengths || null, improvements || null]
    );
  }
  res.json({ ok: true });
});

/** Submit. Checks completeness before locking, so nothing half-filled lands. */
router.post('/:id/submit', requireAuth, async (req, res) => {
  const ballot = await db.get('SELECT * FROM ballots WHERE id = ?', [req.params.id]);
  if (!ballot) return res.status(404).json({ error: 'No such ballot.' });
  if (ballot.judge_id !== req.user.id) {
    return res.status(403).json({ error: 'That is not your ballot.' });
  }
  if (ballot.status !== 'open') {
    return res.status(409).json({ error: 'This ballot is already submitted.' });
  }

  const round = await db.get(
    `SELECT r.*, f.uses_ranking, f.id AS fid
     FROM rounds r JOIN tournaments t ON t.id = r.tournament_id
     JOIN formats f ON f.id = t.format_id WHERE r.id = ?`,
    [ballot.round_id]
  );

  const speeches = await db.all(
    'SELECT position FROM format_speeches WHERE format_id = ?', [round.fid]
  );
  const criteria = await db.all(
    'SELECT id FROM format_criteria WHERE format_id = ?', [round.fid]
  );
  const scores = await db.all(
    'SELECT speech_position, criterion_id FROM ballot_scores WHERE ballot_id = ?',
    [ballot.id]
  );

  const need = speeches.length * criteria.length;
  if (scores.length < need) {
    const scored = new Set(scores.map(s => s.speech_position));
    const missing = speeches.filter(s => !scored.has(s.position)).map(s => s.position);
    return res.status(400).json({
      error: missing.length
        ? `Score every speech before submitting. Still open: ${missing.join(', ')}.`
        : 'Some criteria are unscored.',
    });
  }

  if (round.uses_ranking) {
    const teams = await db.all('SELECT team_id FROM round_teams WHERE round_id = ?', [round.id]);
    const ranks = await db.all('SELECT team_id FROM ballot_rankings WHERE ballot_id = ?', [ballot.id]);
    if (ranks.length < teams.length) {
      return res.status(400).json({
        error: `Rank all ${teams.length} teams before submitting.`,
      });
    }
  }

  await db.run(
    'UPDATE ballots SET status = ?, submitted_at = ? WHERE id = ?',
    ['submitted', new Date().toISOString(), ballot.id]
  );

  // Tell the tab room how many ballots are still outstanding.
  const total = await db.get(
    'SELECT COUNT(*) AS n FROM round_judges WHERE round_id = ?', [round.id]
  );
  const done = await db.get(
    "SELECT COUNT(*) AS n FROM ballots WHERE round_id = ? AND status <> 'open'", [round.id]
  );

  const { broadcast } = require('./rounds');
  broadcast(round.id, {
    type: 'ballot_submitted',
    submitted: Number(done.n),
    total: Number(total.n),
  });

  res.json({ ok: true, submitted: Number(done.n), total: Number(total.n) });
});

module.exports = router;

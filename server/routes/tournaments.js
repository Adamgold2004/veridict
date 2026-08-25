const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

router.get('/', requireAuth, async (_req, res) => {
  const rows = await db.all(
    `SELECT t.*, f.name AS format_name, f.short_name AS format_short,
            (SELECT COUNT(*) FROM teams  WHERE tournament_id = t.id) AS team_count,
            (SELECT COUNT(*) FROM rounds WHERE tournament_id = t.id) AS round_count
     FROM tournaments t
     JOIN formats f ON f.id = t.format_id
     ORDER BY t.created_at DESC`
  );
  res.json({ tournaments: rows });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { name, format_id, host } = req.body || {};
  if (!name || !format_id) {
    return res.status(400).json({ error: 'Give the tournament a name and pick a format.' });
  }

  const fmt = await db.get('SELECT id FROM formats WHERE id = ?', [format_id]);
  if (!fmt) return res.status(400).json({ error: 'That format does not exist.' });

  const tid = randomUUID();
  await db.run(
    `INSERT INTO tournaments (id,name,format_id,host,created_by,created_at)
     VALUES (?,?,?,?,?,?)`,
    [tid, name, format_id, host || null, req.user.id, new Date().toISOString()]
  );

  const row = await db.get('SELECT * FROM tournaments WHERE id = ?', [tid]);
  res.status(201).json({ tournament: row });
});

router.get('/:id', requireAuth, async (req, res) => {
  const t = await db.get(
    `SELECT t.*, f.name AS format_name, f.short_name AS format_short,
            f.team_count, f.speakers_per_team, f.uses_ranking
     FROM tournaments t JOIN formats f ON f.id = t.format_id
     WHERE t.id = ?`,
    [req.params.id]
  );
  if (!t) return res.status(404).json({ error: 'No such tournament.' });

  const teams = await db.all(
    'SELECT * FROM teams WHERE tournament_id = ? ORDER BY name', [t.id]
  );
  for (const team of teams) {
    team.members = await db.all(
      `SELECT u.id, u.display_name, tm.speaker_index
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ? ORDER BY tm.speaker_index`,
      [team.id]
    );
  }

  const rounds = await db.all(
    'SELECT * FROM rounds WHERE tournament_id = ? ORDER BY sequence', [t.id]
  );

  res.json({ tournament: t, teams, rounds });
});

router.post('/:id/teams', requireRole('admin'), async (req, res) => {
  const { name, institution, members } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Give the team a name.' });

  const t = await db.get('SELECT id FROM tournaments WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'No such tournament.' });

  const teamId = randomUUID();
  await db.run(
    'INSERT INTO teams (id,tournament_id,name,institution) VALUES (?,?,?,?)',
    [teamId, t.id, name, institution || null]
  );

  // Speakers are looked up by email; unknown addresses get a placeholder
  // account so the tab room isn't blocked waiting on registrations.
  if (Array.isArray(members)) {
    let idx = 1;
    for (const m of members) {
      if (!m?.email) continue;
      let u = await db.get('SELECT id FROM users WHERE email = ?', [m.email.toLowerCase()]);
      if (!u) {
        const uid = randomUUID();
        await db.run(
          `INSERT INTO users (id,email,password_hash,display_name,institution,role,created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [uid, m.email.toLowerCase(), '!', m.display_name || m.email,
           institution || null, 'debater', new Date().toISOString()]
        );
        u = { id: uid };
      }
      await db.run(
        'INSERT INTO team_members (team_id,user_id,speaker_index) VALUES (?,?,?)',
        [teamId, u.id, idx++]
      );
    }
  }

  res.status(201).json({ team_id: teamId });
});

router.delete('/:id/teams/:teamId', requireRole('admin'), async (req, res) => {
  await db.run('DELETE FROM teams WHERE id = ? AND tournament_id = ?',
    [req.params.teamId, req.params.id]);
  res.json({ ok: true });
});

/** Standings across every completed round. */
router.get('/:id/standings', requireAuth, async (req, res) => {
  const rows = await db.all(
    `SELECT t.id, t.name, t.institution,
            COUNT(br.rank)              AS ballots,
            COALESCE(SUM(
              CASE WHEN br.rank IS NULL THEN 0
                   ELSE (SELECT team_count FROM formats f
                         JOIN tournaments tt ON tt.format_id = f.id
                         WHERE tt.id = t.tournament_id) - br.rank END
            ), 0)                       AS points,
            AVG(br.rank)                AS avg_rank
     FROM teams t
     LEFT JOIN ballot_rankings br ON br.team_id = t.id
     LEFT JOIN ballots b          ON b.id = br.ballot_id AND b.status <> 'open'
     WHERE t.tournament_id = ?
     GROUP BY t.id, t.name, t.institution
     ORDER BY points DESC, avg_rank ASC`,
    [req.params.id]
  );
  res.json({ standings: rows });
});

module.exports = router;

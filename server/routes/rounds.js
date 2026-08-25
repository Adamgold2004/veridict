const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

/* ------------------------------------------------------------------
   Live round state is pushed over Server-Sent Events.

   SSE rather than websockets because the traffic here is one-way —
   the tab room drives the clock, everyone else watches it. That means
   no extra dependency and it survives ordinary HTTP proxies.
------------------------------------------------------------------ */

const watchers = new Map(); // round_id -> Set<res>

function broadcast(roundId, payload) {
  const set = watchers.get(roundId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch { /* client vanished */ }
  }
}

router.get('/:id/stream', requireAuth, async (req, res) => {
  const round = await db.get('SELECT id FROM rounds WHERE id = ?', [req.params.id]);
  if (!round) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  if (!watchers.has(round.id)) watchers.set(round.id, new Set());
  watchers.get(round.id).add(res);

  // Proxies drop idle connections; a comment every 25s keeps it open.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    watchers.get(round.id)?.delete(res);
  });
});

/* ------------------------------------------------------------------ */

async function loadRound(id) {
  const round = await db.get(
    `SELECT r.*, t.name AS tournament_name, t.format_id,
            f.name AS format_name, f.short_name AS format_short, f.uses_ranking
     FROM rounds r
     JOIN tournaments t ON t.id = r.tournament_id
     JOIN formats f     ON f.id = t.format_id
     WHERE r.id = ?`,
    [id]
  );
  if (!round) return null;

  round.speeches = await db.all(
    'SELECT * FROM format_speeches WHERE format_id = ? ORDER BY position',
    [round.format_id]
  );
  round.criteria = await db.all(
    'SELECT * FROM format_criteria WHERE format_id = ? ORDER BY position',
    [round.format_id]
  );
  for (const c of round.criteria) {
    c.bands = await db.all(
      'SELECT low,high,label,descriptor FROM criterion_bands WHERE criterion_id = ? ORDER BY low DESC',
      [c.id]
    );
  }

  round.teams = await db.all(
    `SELECT rt.team_slot, t.id, t.name, t.institution
     FROM round_teams rt JOIN teams t ON t.id = rt.team_id
     WHERE rt.round_id = ? ORDER BY rt.team_slot`,
    [id]
  );
  for (const team of round.teams) {
    team.members = await db.all(
      `SELECT u.id, u.display_name, tm.speaker_index
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ? ORDER BY tm.speaker_index`,
      [team.id]
    );
  }

  round.judges = await db.all(
    `SELECT u.id, u.display_name, rj.is_chair
     FROM round_judges rj JOIN users u ON u.id = rj.user_id
     WHERE rj.round_id = ?`,
    [id]
  );

  // Attach the speaker to each speech so the timer can name them.
  for (const sp of round.speeches) {
    const team = round.teams.find(t => t.team_slot === sp.team_slot);
    const member = team?.members.find(m => m.speaker_index === sp.speaker_index);
    sp.team_name = team?.name || null;
    sp.team_id = team?.id || null;
    sp.speaker_name = member?.display_name || null;
    sp.speaker_id = member?.id || null;
  }

  return round;
}

router.get('/:id', requireAuth, async (req, res) => {
  const round = await loadRound(req.params.id);
  if (!round) return res.status(404).json({ error: 'No such round.' });
  res.json({ round });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { tournament_id, motion, room, stage, sequence, team_ids, judge_ids } = req.body || {};
  if (!tournament_id || !motion) {
    return res.status(400).json({ error: 'A round needs a tournament and a motion.' });
  }

  const t = await db.get('SELECT * FROM tournaments WHERE id = ?', [tournament_id]);
  if (!t) return res.status(400).json({ error: 'That tournament does not exist.' });

  let seq = sequence;
  if (!seq) {
    const last = await db.get(
      'SELECT MAX(sequence) AS m FROM rounds WHERE tournament_id = ?', [tournament_id]
    );
    seq = (last?.m || 0) + 1;
  }

  const rid = randomUUID();
  await db.run(
    `INSERT INTO rounds (id,tournament_id,sequence,stage,motion,room,status,active_speech_position)
     VALUES (?,?,?,?,?,?,?,?)`,
    [rid, tournament_id, seq, stage || 'prelim', motion, room || null, 'scheduled', 1]
  );

  if (Array.isArray(team_ids)) {
    for (let i = 0; i < team_ids.length; i++) {
      if (!team_ids[i]) continue;
      await db.run(
        'INSERT INTO round_teams (round_id,team_id,team_slot) VALUES (?,?,?)',
        [rid, team_ids[i], i + 1]
      );
    }
  }
  if (Array.isArray(judge_ids)) {
    for (let i = 0; i < judge_ids.length; i++) {
      if (!judge_ids[i]) continue;
      await db.run(
        'INSERT INTO round_judges (round_id,user_id,is_chair) VALUES (?,?,?)',
        [rid, judge_ids[i], i === 0 ? 1 : 0]
      );
    }
  }

  res.status(201).json({ round_id: rid });
});

/** Move the round through its lifecycle. Completing it reveals ballots. */
router.post('/:id/status', requireRole('admin'), async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['draft', 'scheduled', 'live', 'judging', 'completed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Unrecognised round status.' });
  }

  await db.run('UPDATE rounds SET status = ? WHERE id = ?', [status, req.params.id]);
  broadcast(req.params.id, { type: 'status', status });
  res.json({ ok: true, status });
});

/**
 * The shared clock. The chair drives it; every other client follows.
 * Elapsed time is stored rather than a countdown, so a client that
 * joins late can compute exactly where the speech is.
 */
router.post('/:id/timer', requireAuth, async (req, res) => {
  const { action, position } = req.body || {};
  const round = await db.get('SELECT * FROM rounds WHERE id = ?', [req.params.id]);
  if (!round) return res.status(404).json({ error: 'No such round.' });

  const chair = await db.get(
    'SELECT 1 AS ok FROM round_judges WHERE round_id = ? AND user_id = ? AND is_chair = 1',
    [round.id, req.user.id]
  );
  if (!chair && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the chair can run the clock.' });
  }

  const nowIso = new Date().toISOString();
  let { speech_elapsed_sec, timer_running, active_speech_position } = round;

  if (action === 'start') {
    timer_running = 1;
    await db.run(
      'UPDATE rounds SET timer_running = 1, speech_started_at = ? WHERE id = ?',
      [nowIso, round.id]
    );
  } else if (action === 'pause') {
    // Bank the time accrued since the last start.
    const since = round.speech_started_at
      ? Math.floor((Date.now() - new Date(round.speech_started_at).getTime()) / 1000)
      : 0;
    speech_elapsed_sec = (round.speech_elapsed_sec || 0) + since;
    timer_running = 0;
    await db.run(
      'UPDATE rounds SET timer_running = 0, speech_elapsed_sec = ?, speech_started_at = NULL WHERE id = ?',
      [speech_elapsed_sec, round.id]
    );
  } else if (action === 'reset') {
    speech_elapsed_sec = 0;
    timer_running = 0;
    await db.run(
      'UPDATE rounds SET timer_running = 0, speech_elapsed_sec = 0, speech_started_at = NULL WHERE id = ?',
      [round.id]
    );
  } else if (action === 'goto') {
    active_speech_position = Number(position) || 1;
    speech_elapsed_sec = 0;
    timer_running = 0;
    await db.run(
      `UPDATE rounds SET active_speech_position = ?, timer_running = 0,
              speech_elapsed_sec = 0, speech_started_at = NULL WHERE id = ?`,
      [active_speech_position, round.id]
    );
  } else {
    return res.status(400).json({ error: 'Unrecognised timer action.' });
  }

  const state = {
    type: 'timer',
    active_speech_position,
    speech_elapsed_sec,
    timer_running,
    speech_started_at: timer_running ? nowIso : null,
  };
  broadcast(round.id, state);
  res.json(state);
});

/**
 * Panel results. Withheld until the round is completed — a judge
 * seeing the panel mid-round defeats the point of a panel.
 */
router.get('/:id/results', requireAuth, async (req, res) => {
  const round = await loadRound(req.params.id);
  if (!round) return res.status(404).json({ error: 'No such round.' });

  if (round.status !== 'completed' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Results open once the round is closed.' });
  }

  const teamResults = await db.all(
    `SELECT t.id, t.name, AVG(br.rank) AS avg_rank, COUNT(br.rank) AS ballots
     FROM round_teams rt
     JOIN teams t ON t.id = rt.team_id
     LEFT JOIN ballot_rankings br ON br.team_id = t.id
     LEFT JOIN ballots b ON b.id = br.ballot_id
                        AND b.round_id = rt.round_id AND b.status <> 'open'
     WHERE rt.round_id = ?
     GROUP BY t.id, t.name
     ORDER BY avg_rank ASC`,
    [round.id]
  );

  const speakerScores = await db.all(
    `SELECT bs.speech_position, SUM(bs.score) AS total, b.judge_id
     FROM ballot_scores bs
     JOIN ballots b ON b.id = bs.ballot_id
     WHERE b.round_id = ? AND b.status <> 'open'
     GROUP BY bs.speech_position, b.judge_id`,
    [round.id]
  );

  // Average each speech across the panel rather than showing one opinion.
  const bySpeech = {};
  for (const s of speakerScores) {
    (bySpeech[s.speech_position] ||= []).push(Number(s.total));
  }
  const speakers = round.speeches.map(sp => {
    const list = bySpeech[sp.position] || [];
    return {
      position: sp.position,
      short_label: sp.short_label,
      speaker_name: sp.speaker_name,
      team_name: sp.team_name,
      avg: list.length ? +(list.reduce((a, b) => a + b, 0) / list.length).toFixed(2) : null,
      ballots: list.length,
    };
  });

  const reasons = await db.all(
    `SELECT u.display_name AS judge, b.reasoning
     FROM ballots b JOIN users u ON u.id = b.judge_id
     WHERE b.round_id = ? AND b.status <> 'open' AND b.reasoning IS NOT NULL`,
    [round.id]
  );

  res.json({ round: { id: round.id, motion: round.motion, status: round.status },
             teams: teamResults, speakers, reasons });
});

module.exports = { router, broadcast };

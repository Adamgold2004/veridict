/* The judging screen.
   The clock is server-driven: the chair starts it, the server records
   when, and every client computes its own display from that timestamp.
   Local counters would drift apart across a panel. */

(async () => {
  const roundId = qs('round');
  if (!roundId) { location.href = '/app'; return; }

  const user = await requireUser();
  if (!user) return;
  await mountNav('/app');

  let round, ballot, criteria, speeches, teams;
  let current = 1;
  let timer = { running: 0, elapsed: 0, startedAt: null };
  const scores = {};   // position -> { criterionId: value }
  const ranks = {};    // teamId -> rank
  let saveTimer = null;

  // ---------- load ----------
  try {
    round = (await api.get('/rounds/' + roundId)).round;
    const b = await api.get('/ballots/round/' + roundId);
    ballot = b.ballot;

    criteria = round.criteria;
    speeches = round.speeches;
    teams = round.teams;
    current = round.active_speech_position || 1;

    timer = {
      running: round.timer_running ? 1 : 0,
      elapsed: round.speech_elapsed_sec || 0,
      startedAt: round.speech_started_at,
    };

    for (const s of b.scores) {
      (scores[s.speech_position] ||= {})[s.criterion_id] = Number(s.score);
    }
    for (const r of b.rankings) ranks[r.team_id] = r.rank;
    if (ballot.reasoning) $('#rfd').value = ballot.reasoning;
  } catch (err) {
    showError(err.message);
    return;
  }

  $('#page').hidden = false;
  $('#round-label').textContent =
    `Round ${round.sequence} · ${round.format_short}${round.room ? ' · ' + round.room : ''}`;
  $('#motion').textContent = round.motion;
  document.title = `Round ${round.sequence} ballot — Veridict`;

  const isChair = ballot.is_chair || user.role === 'admin';
  if (!isChair) {
    $$('#t-toggle, #t-reset, #t-next').forEach(b => b.disabled = true);
    $('#t-hint').textContent = 'The chair runs the clock';
  }

  const locked = ballot.status !== 'open';
  const sideOf = slot => (slot % 2 === 1 ? 'gov' : 'opp');

  // ---------- flow strip ----------
  function drawFlow() {
    const f = $('#flow');
    f.style.gridTemplateColumns =
      `repeat(${Math.min(speeches.length, window.innerWidth < 560 ? 2 : window.innerWidth < 900 ? 4 : speeches.length)},1fr)`;
    f.innerHTML = speeches.map(s => {
      const filled = scores[s.position] &&
        Object.keys(scores[s.position]).length === criteria.length;
      return `
        <button class="flow-cell${filled ? ' done' : ''}" data-side="${sideOf(s.team_slot)}"
                data-pos="${s.position}" aria-current="${s.position === current}">
          <span class="pos">${String(s.position).padStart(2, '0')}</span>
          <span class="abbr">${esc(s.short_label)}</span>
          <span class="who">${esc(s.speaker_name || 'Unassigned')}</span>
        </button>`;
    }).join('');
    $$('.flow-cell', f).forEach(c =>
      c.onclick = () => goTo(Number(c.dataset.pos)));
  }

  // ---------- timer ----------
  function speech() {
    return speeches.find(s => s.position === current) || speeches[0];
  }

  function elapsedNow() {
    if (timer.running && timer.startedAt) {
      return timer.elapsed +
        Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000);
    }
    return timer.elapsed;
  }

  function drawTrack() {
    const sp = speech();
    $('#p-head').style.left = '0';
    $('#p-head').style.width = (sp.protected_head_sec / sp.duration_sec * 100) + '%';
    $('#p-tail').style.right = '0';
    $('#p-tail').style.width = (sp.protected_tail_sec / sp.duration_sec * 100) + '%';

    $$('.tick').forEach(t => t.remove());
    for (let m = 1; m * 60 < sp.duration_sec; m++) {
      const t = document.createElement('div');
      t.className = 'tick';
      t.style.left = (m * 60 / sp.duration_sec * 100) + '%';
      t.innerHTML = `<span>${m}</span>`;
      $('#track').appendChild(t);
    }
  }

  function paint() {
    const sp = speech();
    const el = elapsedNow();
    const left = sp.duration_sec - el;
    const pct = Math.min(el / sp.duration_sec, 1) * 100;

    $('#t-read').textContent = mmss(left);
    $('#t-fill').style.width = pct + '%';
    $('#t-head').style.left = pct + '%';
    $('#t-pos').textContent = `${sp.position} of ${speeches.length}`;
    $('#t-name').textContent =
      `${sp.label}${sp.speaker_name ? ' — ' + sp.speaker_name : ''}`;
    $('#scoring-for').textContent = sp.label;

    const inTail = sp.protected_tail_sec > 0 && el >= sp.duration_sec - sp.protected_tail_sec;
    const over = left < 0;
    $('#t-read').className = 'readout' + (over ? ' over' : inTail ? ' warn' : '');
    $('#t-fill').className = 'fill' + (over ? ' over' : inTail ? ' warn' : '');
    $('#t-toggle').textContent = timer.running ? 'Pause' : (el ? 'Resume' : 'Start speech');
  }

  setInterval(paint, 500);

  async function timerAction(action, position) {
    if (!isChair) return;
    try {
      const s = await api.post(`/rounds/${roundId}/timer`, { action, position });
      applyTimer(s);
    } catch (err) { showError(err.message); }
  }

  function applyTimer(s) {
    timer = {
      running: s.timer_running ? 1 : 0,
      elapsed: s.speech_elapsed_sec || 0,
      startedAt: s.speech_started_at,
    };
    if (s.active_speech_position && s.active_speech_position !== current) {
      current = s.active_speech_position;
      drawTrack(); drawFlow(); drawCriteria();
    }
    paint();
  }

  function goTo(pos) {
    current = pos;
    drawTrack(); drawFlow(); drawCriteria(); paint();
    if (isChair) timerAction('goto', pos);
  }

  $('#t-toggle').onclick = () => timerAction(timer.running ? 'pause' : 'start');
  $('#t-reset').onclick = () => timerAction('reset');
  $('#t-next').onclick = () =>
    goTo(Math.min(current + 1, speeches.length));

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
      e.preventDefault();
      timerAction(timer.running ? 'pause' : 'start');
    }
  });

  // ---------- live sync ----------
  const es = new EventSource(`/api/rounds/${roundId}/stream`);
  es.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'timer') applyTimer(msg);
    if (msg.type === 'status' && msg.status === 'completed') {
      location.href = '/results?round=' + roundId;
    }
  };

  // ---------- criteria ----------
  const bandFor = (c, v) =>
    c.bands.find(b => v >= b.low && v <= b.high) || c.bands[c.bands.length - 1];

  function drawCriteria() {
    if (!scores[current]) {
      scores[current] = Object.fromEntries(
        criteria.map(c => [c.id, Number(c.default_val)]));
    }
    const vals = scores[current];

    $('#criteria').innerHTML = criteria.map(c => {
      const v = vals[c.id], b = bandFor(c, v);
      return `<div class="criterion">
        <div class="crit-head">
          <h3>${esc(c.name)}</h3>
          <span class="crit-val" id="v-${c.id}">${v}<small> / ${c.score_max}</small></span>
        </div>
        <p class="crit-desc">${esc(c.description || '')}</p>
        <input type="range" min="${c.score_min}" max="${c.score_max}" value="${v}"
               data-c="${c.id}" aria-label="${esc(c.name)} score" ${locked ? 'disabled' : ''}>
        ${b ? `<div class="band" id="b-${c.id}"><b>${esc(b.label)}</b>${esc(b.descriptor)}</div>` : ''}
      </div>`;
    }).join('');

    $$('#criteria input[type=range]').forEach(r => {
      r.oninput = () => {
        const c = criteria.find(x => x.id === r.dataset.c);
        const v = Number(r.value);
        scores[current][c.id] = v;
        const b = bandFor(c, v);
        $('#v-' + c.id).innerHTML = `${v}<small> / ${c.score_max}</small>`;
        if (b) $('#b-' + c.id).innerHTML = `<b>${esc(b.label)}</b>${esc(b.descriptor)}`;
        drawTally();
        queueSave();
      };
    });
    drawTally();
  }

  function drawTally() {
    const v = scores[current] || {};
    $('#tally-rows').innerHTML = criteria.map(c =>
      `<div class="tally-row"><span>${esc(c.name)}</span><b>${v[c.id] ?? 0}</b></div>`).join('');
    $('#tally-total').textContent =
      criteria.reduce((t, c) => t + (v[c.id] || 0), 0);
  }

  // Debounced so dragging a slider doesn't fire a request per pixel.
  function queueSave() {
    clearTimeout(saveTimer);
    $('#saved').textContent = 'Saving…';
    saveTimer = setTimeout(async () => {
      try {
        await api.put(`/ballots/${ballot.id}/scores`, {
          speech_position: current,
          scores: scores[current],
        });
        $('#saved').textContent = 'Saved ' +
          new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        drawFlow();
      } catch (err) {
        $('#saved').textContent = 'Not saved';
        showError(err.message);
      }
    }, 600);
  }

  // ---------- ranking ----------
  function drawRanks() {
    if (!round.uses_ranking) {
      $('#rank-block').hidden = true;
      return;
    }
    $('#rank-hint').textContent = `First through ${teams.length === 4 ? 'fourth' : 'last'}`;
    $('#ranks').innerHTML = teams.map(t => `
      <div class="rank-row side-${sideOf(t.team_slot)}">
        <div>
          <span class="slot">${esc(slotName(t.team_slot))}</span>
          <span class="tname">${esc(t.name)}</span>
        </div>
        <div class="rank-pick">
          ${teams.map((_, i) => i + 1).map(n => `
            <button data-t="${t.id}" data-r="${n}"
                    aria-pressed="${ranks[t.id] === n}"
                    aria-label="Rank ${esc(t.name)} ${n}"
                    ${locked ? 'disabled' : ''}>${n}</button>`).join('')}
        </div>
      </div>`).join('');

    $$('#ranks button').forEach(btn => btn.onclick = async () => {
      const teamId = btn.dataset.t, r = Number(btn.dataset.r);
      // A rank is exclusive — taking it releases whoever held it.
      for (const k in ranks) if (ranks[k] === r) delete ranks[k];
      ranks[teamId] = r;
      drawRanks();
      checkReady();
      try {
        await api.put(`/ballots/${ballot.id}/rankings`, {
          rankings: Object.entries(ranks).map(([team_id, rank]) => ({ team_id, rank })),
        });
      } catch (err) { showError(err.message); }
    });
  }

  function slotName(slot) {
    if (round.uses_ranking && teams.length === 4) {
      return ['Opening Government', 'Opening Opposition',
              'Closing Government', 'Closing Opposition'][slot - 1] || `Slot ${slot}`;
    }
    return slot % 2 === 1 ? 'Proposition' : 'Opposition';
  }

  // ---------- reasoning ----------
  let rfdTimer = null;
  $('#rfd').disabled = locked;
  $('#rfd').oninput = () => {
    clearTimeout(rfdTimer);
    rfdTimer = setTimeout(() => {
      api.put(`/ballots/${ballot.id}/reasoning`, { reasoning: $('#rfd').value })
         .catch(() => {});
    }, 800);
  };

  // ---------- submit ----------
  function checkReady() {
    if (locked) {
      $('#submit').disabled = true;
      $('#submit').textContent = 'Ballot submitted';
      $('#submit-note').textContent = 'Locked. Results open when the chair closes the round.';
      return;
    }
    const unscored = speeches.filter(s =>
      !scores[s.position] || Object.keys(scores[s.position]).length < criteria.length);
    const unranked = round.uses_ranking ? teams.length - Object.keys(ranks).length : 0;

    const ready = !unscored.length && !unranked;
    $('#submit').disabled = !ready;
    $('#submit-note').textContent = ready
      ? 'Once submitted, this ballot locks and the tab room is notified.'
      : [unscored.length ? `${unscored.length} ${unscored.length === 1 ? 'speech' : 'speeches'} unscored` : '',
         unranked ? `${unranked} ${unranked === 1 ? 'team' : 'teams'} unranked` : '']
        .filter(Boolean).join(' · ');
  }

  $('#submit').onclick = async () => {
    clearError();
    $('#submit').disabled = true;
    $('#submit').textContent = 'Submitting…';
    try {
      // Flush anything the debounce hasn't sent yet.
      clearTimeout(saveTimer);
      for (const pos of Object.keys(scores)) {
        await api.put(`/ballots/${ballot.id}/scores`, {
          speech_position: Number(pos), scores: scores[pos],
        });
      }
      const r = await api.post(`/ballots/${ballot.id}/submit`);
      $('#submit').textContent = 'Ballot submitted';
      $('#submit-note').textContent =
        `${r.submitted} of ${r.total} ballots in.`;
      showOk('Ballot submitted. It is now locked.');
    } catch (err) {
      showError(err.message);
      $('#submit').textContent = 'Submit ballot';
      checkReady();
    }
  };

  // ---------- go ----------
  drawTrack(); drawFlow(); drawCriteria(); drawRanks(); checkReady(); paint();
  window.addEventListener('resize', drawFlow);
})();

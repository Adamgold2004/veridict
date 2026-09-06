/* Exercises the recording pipeline end to end, including the consent gate. */
const BASE = 'http://localhost:3000';

const login = async (e, p) => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: p }),
  });
  if (!r.ok) throw new Error('login failed: ' + e);
  return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
};
const J = async (cookie, method, path, body) => {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

(async () => {
  const judge = await login('judge@veridict.local', 'judge1234');
  const admin = await login('admin@veridict.local', 'admin1234');

  const tid = (await J(judge, 'GET', '/tournaments')).data.tournaments[0].id;
  const rid = (await J(judge, 'GET', '/tournaments/' + tid)).data.rounds[0].id;
  const round = (await J(judge, 'GET', '/rounds/' + rid)).data.round;

  console.log('=== consent state for this round ===');
  const cons = (await J(judge, 'GET', `/recordings/consent/round/${rid}`)).data.consent;
  cons.forEach(c => console.log(`  ${c.display_name.padEnd(18)} ${c.status.padEnd(9)} ${c.is_minor ? 'under 18' : 'adult'}`));

  // A tiny but real webm-ish payload. The server stores bytes, not codecs.
  const fake = Buffer.alloc(64000, 7);

  const upload = async (cookie, pos) => {
    const r = await fetch(`${BASE}/api/recordings/round/${rid}/${pos}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'audio/webm', 'X-Duration-Sec': '412' },
      body: fake,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  console.log('\n=== upload for a consented speaker (speech 1) ===');
  const ok1 = await upload(judge, 1);
  console.log(' ', ok1.status, JSON.stringify(ok1.data));

  // Find a speech whose speaker has no consent.
  const blockedUser = cons.find(c => c.status !== 'granted');
  const blockedSpeech = round.speeches.find(s => s.speaker_id === blockedUser?.id);
  console.log(`\n=== upload for UNCONSENTED speaker (${blockedUser?.display_name}, speech ${blockedSpeech?.position}) ===`);
  const blocked = await upload(judge, blockedSpeech.position);
  console.log(' ', blocked.status, JSON.stringify(blocked.data));

  console.log('\n=== a non-judge tries to upload ===');
  const debater = await login('debater@veridict.local', 'debate1234');
  const nope = await upload(debater, 1);
  console.log(' ', nope.status, JSON.stringify(nope.data));

  console.log('\n=== playback permissions ===');
  const recId = ok1.data.id;
  const tryPlay = async (cookie, who) => {
    const r = await fetch(`${BASE}/api/recordings/${recId}/audio`, { headers: { cookie } });
    console.log(`  ${who.padEnd(22)} ${r.status} ${r.headers.get('content-type')}`);
    return r;
  };
  await tryPlay(judge, 'judge on the round');
  await tryPlay(admin, 'admin');
  await tryPlay(debater, 'unrelated debater');

  // The speaker of speech 1 should be able to hear their own audio.
  const sp1 = round.speeches[0];
  const spEmail = sp1.speaker_name.toLowerCase().replace(/[^a-z]/g, '.') + '@veridict.local';
  const speaker = await login(spEmail, 'debate1234');
  await tryPlay(speaker, 'the speaker themselves');

  console.log('\n=== range request (seeking) ===');
  const rr = await fetch(`${BASE}/api/recordings/${recId}/audio`, {
    headers: { cookie: judge, range: 'bytes=0-999' },
  });
  console.log('  status', rr.status, 'range', rr.headers.get('content-range'));

  console.log('\n=== speaker sees it in their own list ===');
  const mine = await J(speaker, 'GET', '/recordings/mine');
  console.log(' ', mine.data.recordings.length, 'recording(s):',
    mine.data.recordings.map(r => `R${r.sequence} pos${r.speech_position} ${r.duration_sec}s`).join(', '));

  console.log('\n=== storage usage ===');
  console.log(' ', JSON.stringify((await J(admin, 'GET', '/recordings/usage')).data));

  console.log('\n=== withdrawing consent deletes the audio ===');
  const wd = await J(admin, 'PUT', `/recordings/consent/${sp1.speaker_id}`,
    { status: 'withheld', is_minor: false });
  console.log('  withdraw:', JSON.stringify(wd.data));
  const after = await fetch(`${BASE}/api/recordings/${recId}/audio`, { headers: { cookie: judge } });
  console.log('  playback after withdrawal:', after.status);
  console.log('  usage now:', JSON.stringify((await J(admin, 'GET', '/recordings/usage')).data));

  console.log('\n=== granting a minor without a guardian name ===');
  const minor = cons.find(c => c.is_minor);
  console.log(' ', JSON.stringify((await J(admin, 'PUT', `/recordings/consent/${minor.id}`,
    { status: 'granted', is_minor: true })).data));
  console.log('  with a guardian name:');
  console.log(' ', JSON.stringify((await J(admin, 'PUT', `/recordings/consent/${minor.id}`,
    { status: 'granted', is_minor: true, guardian_name: 'R. Okonkwo' })).data));

  console.log('\n=== per-speech feedback ===');
  const bid = (await J(judge, 'GET', '/ballots/round/' + rid)).data.ballot.id;
  console.log(' ', JSON.stringify((await J(judge, 'PUT', `/ballots/${bid}/feedback`, {
    speech_position: 1,
    strengths: 'The enforcement example was concrete and landed.',
    improvements: 'Take a point of information earlier.',
  })).data));
  const back = (await J(judge, 'GET', '/ballots/round/' + rid)).data.feedback;
  console.log('  stored:', JSON.stringify(back));
})();

/* Speech recorder.

   The app already knows exactly when each speech starts and ends, so
   audio is cut per speech rather than saved as one long file someone
   has to scrub through afterwards. Each clip is uploaded the moment
   its speech ends.

   Nothing opens the microphone until consent for every speaker in the
   round has been checked. */

function createRecorder({ roundId, speeches, onState }) {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let activePosition = null;
  let startedAt = null;
  let uploadPromise = Promise.resolve();
  let consent = {};          // userId -> 'granted' | 'withheld' | 'pending'
  let speakerOf = {};        // position -> { id, name }
  const state = { supported: false, armed: false, recording: false, error: null };

  function push(patch) {
    Object.assign(state, patch);
    onState({ ...state });
  }

  state.supported = typeof window.MediaRecorder !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia;

  /** Which speeches may be recorded, and why the others may not. */
  async function loadConsent() {
    const { consent: rows } = await api.get(`/recordings/consent/round/${roundId}`);
    consent = Object.fromEntries(rows.map(r => [r.id, r.status]));
    for (const sp of speeches) {
      if (sp.speaker_id) speakerOf[sp.position] = { id: sp.speaker_id, name: sp.speaker_name };
    }
    return rows;
  }

  function allowed(position) {
    const s = speakerOf[position];
    if (!s) return false;                       // unassigned slot
    return consent[s.id] === 'granted';
  }

  function blockedReason(position) {
    const s = speakerOf[position];
    if (!s) return 'No speaker assigned to this slot.';
    const c = consent[s.id];
    if (c === 'withheld') return `${s.name} has declined to be recorded.`;
    return `${s.name} has no recording consent on file.`;
  }

  /** Asks for the microphone once, then keeps the stream for the round. */
  async function arm() {
    if (!state.supported) {
      push({ error: 'This browser cannot record audio.' });
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      push({ armed: true, error: null });
      return true;
    } catch (err) {
      push({
        error: err.name === 'NotAllowedError'
          ? 'Microphone access was refused. Allow it in the browser address bar to record.'
          : 'No microphone available.',
      });
      return false;
    }
  }

  function disarm() {
    stop();
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    push({ armed: false, recording: false });
  }

  function start(position) {
    if (!stream || state.recording) return;
    if (!allowed(position)) {
      push({ error: blockedReason(position) });
      return;
    }

    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';

    chunks = [];
    // 32 kbps mono is clear for speech and keeps a 7-minute clip near 1.7 MB.
    recorder = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      audioBitsPerSecond: 32000,
    });
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const positionToUpload = activePosition;
      const started = startedAt;
      const clip = chunks;
      chunks = [];
      uploadPromise = uploadPromise.then(() => upload(positionToUpload, started, mime, clip));
    };
    activePosition = position;
    startedAt = Date.now();
    recorder.start(1000);
    push({ recording: true, error: null });
  }

  function stop() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    push({ recording: false });
  }

  async function upload(position, started, mime, clip) {
    if (!clip.length) return;
    const blob = new Blob(clip, { type: mime || 'audio/webm' });
    const seconds = Math.round((Date.now() - started) / 1000);

    push({ uploading: true });
    try {
      const res = await fetch(`/api/recordings/round/${roundId}/${position}`, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          'X-Duration-Sec': String(seconds),
        },
        body: blob,
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      push({ uploading: false, lastSaved: { position, bytes: data.bytes }, error: null });
    } catch (err) {
      push({ uploading: false, error: err.message });
    }
  }

  return { loadConsent, allowed, blockedReason, arm, disarm, start, stop, state };
}

# Veridict

Live judging and tournament management for competitive debate. Node + Express
backend, plain HTML/CSS/JS frontend, SQLite or Postgres.

## Run it

```bash
npm install
npm run seed
npm start
```

Open http://localhost:3000. That's the whole setup — SQLite needs no server,
no account, no connection string.

Sign in with any of the seeded accounts:

| Role | Email | Password |
|---|---|---|
| Tab room (admin) | `admin@veridict.local` | `admin1234` |
| Chair judge | `judge@veridict.local` | `judge1234` |
| Panel judge | `judge2@veridict.local` | `judge1234` |

The seed creates a tournament with one live BP round, four teams, eight named
speakers, and two judges — so there's something real to click through
immediately.

**Try this first:** sign in as the chair judge, open the live round's ballot,
and press space. That's the core of the product.

## Use Postgres instead

Set `DATABASE_URL` and the same code runs on Postgres:

```bash
cp .env.example .env
# edit DATABASE_URL, then
npm run seed && npm start
```

Works with Supabase and Neon free tiers. Connection strings for both are in
`.env.example`.

Or with Docker:

```bash
docker compose up
```

## Test it

```bash
npm test
```

Loads every page in jsdom against a running server and checks that each one
renders without JavaScript errors. Start the server in another terminal first.

`interact-test.js` goes further — it drives the ballot through the real DOM
controls (clicking speeches, dragging sliders, ranking teams, submitting) and
then verifies the results came back correctly from the server.

## Recording speeches

Judges can record a round. The app already knows when each speech starts and
stops, so audio is cut per speech automatically — a debater opens their own
speech and hears just that, rather than scrubbing a one-hour file.

Clips are ~1.7 MB for a 7-minute speech (32 kbps mono opus), so a full eight-speech
round is around 14 MB.

**Recording is gated on consent.** A speaker with nothing on file is never
captured — the upload is refused by the server, not filtered afterwards. Set
consent in the tab room under **Consent**. Granting it for an under-18 requires
the name of the parent or guardian who gave it, and marking anyone withheld
deletes any audio already recorded of them.

Who can play a clip: the speaker themselves, the judges who heard that round,
and admins. Nobody else, including other debaters in the same round. Audio is
streamed through the app with that check on every request — never served as a
public file.

Clips expire after 180 days. Change it with `RETENTION_DAYS` in `.env`, or set
`0` to keep them indefinitely. Deletion isn't automatic; schedule the pruner:

```
0 3 * * *  cd /path/to/veridict && npm run prune
```

Storage lives on disk in `storage/` by default. Watch the size — a club running
five rounds across ten rooms generates roughly 700 MB a day, which will exhaust
a 1 GB free tier quickly. The Consent page shows current usage.

## What works

Verified by running it:

- Registration, sign-in, sessions, role separation
- Tab room: create tournaments, add teams, schedule rounds with team and judge
  allocation, move rounds through their lifecycle
- Live ballot: shared timer, per-speech scoring against format criteria with
  band descriptors, team ranking, written reasons, autosave, submission
- Results: team ranking and speaker scores averaged across the panel
- Standings across a tournament
- Per-speech recording with automatic splitting, upload, and playback
- Consent register, including guardian records for under-18s
- Debater view of their own speeches with judges' written feedback
- Retention pruning

Guards tested and holding:

- A judge cannot read or write another judge's ballot
- Scores outside a criterion's range are rejected
- Results stay hidden until the round is closed
- Incomplete ballots are refused, and the error names what's missing
- Two teams cannot share a rank
- Only the chair can drive the clock
- A submitted ballot cannot be edited or resubmitted
- Audio for an unconsented speaker is refused
- Only judges assigned to a round can record it
- Unrelated debaters cannot play another speaker's audio
- Withdrawing consent deletes existing recordings
- Granting consent for a minor without a guardian name is refused

## Not built yet

- Bracket generation and power-pairing (rounds are created by hand)
- Judge conflicts and availability
- Email, exports, printing

## How it fits together

```
server/
  index.js      Express app, static hosting, error handling
  db.js         one query interface over SQLite and Postgres
  auth.js       JWT session cookies, role guards
  schema.sql    portable schema for both engines
  seed.js       formats, criteria, demo tournament
  prune.js      deletes expired recordings
  routes/       auth · formats · tournaments · rounds · ballots · recordings
public/
  index.html      landing
  login.html      sign in and register
  app.html        tournament list
  tournament.html rounds, teams, standings
  tab.html        organiser tools
  ballot.html     live judging with recorder
  results.html    round results
  consent.html    recording consent register
  me.html         a debater's own speeches and feedback
  css/app.css     shared design system
  js/app.js       API client, nav, helpers
  js/ballot.js    judging screen logic
  js/recorder.js  microphone capture, split per speech
```

### Formats are data

Every debate format scores differently. BP ranks four teams first through
fourth; World Schools picks a winner between two and adds reply speeches.
Hardcoding either means rewriting the app to support the next one.

So formats, speech order, and judging criteria are rows:

- `formats` — team counts, whether teams are ranked
- `format_speeches` — order, durations, protected-time windows
- `format_criteria` — the rubric
- `criterion_bands` — descriptors anchoring each score range

**To load your own criteria:** edit the `FORMATS` array in `server/seed.js`,
delete `db/veridict.sqlite`, and run `npm run seed`. No other file changes.
The ballot screen reads whatever the API returns.

### The clock is server-side

The chair starts the timer; the server records the timestamp; every client
computes its own display from that. Clients that each count locally drift
apart, and a panel disagreeing about whether a speaker is over time is exactly
the argument the software should prevent. A judge who reconnects mid-speech
lands where the room actually is.

Updates go out over Server-Sent Events rather than websockets — the traffic is
one-way, so SSE means no extra dependency and no proxy trouble.

### Panel independence is enforced at the API

No endpoint returns another judge's open ballot. It's checked on the server,
not hidden in the interface, because a UI-level check falls over the moment
someone opens the network tab.

## Design notes

The interface is built from debate's own artifacts rather than dashboard
conventions.

**Protected time is drawn on the timer.** In BP, points of information are
barred during the first and last minute of a speech. Judges normally track
this mentally. Here it's hatched onto the track — hatching rather than a
colour fill, because it marks a rule, not a quantity.

**Government and opposition hold fixed colours** — sage and claret — across
the flow strip, ranking rows, and results. Side is what a judge needs to read
fastest.

**Numbers are monospaced** with tabular figures, so the clock doesn't jitter
as digits change width.

**Type:** Zilla Slab for headings (a slab serif has the quality of a printed
form, which is what a ballot is), Public Sans for body, JetBrains Mono for
anything numeric.

No icon library — the few marks needed are type or inline SVG.

## Before deploying

1. Change `JWT_SECRET` in `.env`
2. Set `NODE_ENV=production` so session cookies are marked secure
3. Change or delete the seeded demo accounts
4. Put it behind HTTPS — `getUserMedia` will not open a microphone over plain
   HTTP on any host except localhost, so recording simply won't work without it
5. Schedule `npm run prune` so recordings actually expire
6. Back up `storage/` — it isn't in version control

## Licence

MIT

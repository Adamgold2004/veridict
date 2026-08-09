# Veridict

A debate-adjudication tool, rebuilt per `redesign-spec.md`:

- **Backend** — NestJS (`backend/`), in-memory data store, modules per the spec
  (`FormatModule`, `RoundModule`, `ScoringModule`, `BallotModule`, `AiSuggestionModule`),
  every score validated server-side against the active format's declared bands.
- **Frontend** — Sass 7-1 architecture + vanilla JS + GSAP (`frontend/`), the
  4-step wizard (Setup → Speeches → AI Suggestion → Ballot), served as static
  files by the same NestJS process.

## Run it

```bash
# 1. Build the frontend (Sass -> CSS, copies JS/HTML into frontend/dist)
cd frontend
npm install
npm run build

# 2. Build and start the backend (also serves frontend/dist)
cd ../backend
npm install
npm run build
npm start
```

Then open **http://localhost:3000**.

For backend development without a rebuild step:

```bash
cd backend
npm run dev   # ts-node, restarts require re-running
```

## What's implemented

### Debate-accuracy fixes (§3)
- WSDC: 8 speeches (3 substantive + 1 reply per side); replies score
  content + strategy only, and only a speaker who delivered a substantive
  speech for that side can be assigned the reply.
- BP: forced full ranking (1st–4th, all four teams, no ties/omissions) via a
  reusable `RankingSelector` component.
- Every score is clamped/validated client-side for UX and **re-validated
  server-side** as the actual source of truth — a `50` in a `24–32` band is
  rejected with a 400 either way.
- Low-point win detection blocks submission until the judge explicitly
  confirms it's intentional.
- Switching formats mid-session instantiates a brand-new `Round` entity —
  status, timestamps, reason-for-decision, and lock state all reset.
- BP's 8 roles each get a unique bench badge (`OG1, OG2, OO1, OO2, CG1, CG2,
  CO1, CO2`) — no duplicate `O1`/`C1` labels.

### New features (§4)
- Timer & POI panel: format-aware countdown ring (GSAP + SVG
  `stroke-dashoffset`), protected-time bell-flash, POI toggle disabled
  during protected time, accepted/declined log per speech.
- In-app scoring guide with real band descriptions, viewable inline from
  the Ballot step.

### AI boundary (§6)
The `AiSuggestionModule` only reads existing round data and never writes to
the ballot on its own. A judge must hit "Accept into ballot" per field
(currently: reason for decision) for anything to land — enforced both in the
UI and in the backend's `acceptField` allow-list.

## Notes on scope
Data is stored in-memory (`Map`) rather than a database, matching the scope
of the redesign spec, which described module boundaries and domain rules
rather than persistence infrastructure. Swapping in a real datastore means
replacing the internals of `RoundService` without touching its public
interface or any of the controllers.
# veridict

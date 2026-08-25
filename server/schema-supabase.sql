-- ============================================================
-- VERIDICT — schema for Postgres 14+ / Supabase
-- ============================================================
-- Design note: nothing about a specific debate format is
-- hardcoded. Formats, their speech order, and their scoring
-- criteria are all rows. Adding WSDC or a house format is an
-- INSERT, never a migration.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- People
-- ------------------------------------------------------------

create type app_role as enum ('admin', 'judge', 'debater', 'spectator');

create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  institution   text,
  role          app_role not null default 'spectator',
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Formats: the shape of a debate
-- ------------------------------------------------------------

create table formats (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,          -- 'British Parliamentary'
  short_name      text not null,                 -- 'BP'
  team_count      int  not null,                 -- 4 for BP, 2 for LD
  speakers_per_team int not null,
  -- Speaker score range for this format. BP is 50-100, WSDC differs.
  score_min       numeric(5,2) not null,
  score_max       numeric(5,2) not null,
  score_step      numeric(4,2) not null default 1,
  -- Does the format rank teams (BP: 1st-4th) or pick a winner (LD)?
  uses_ranking    boolean not null default false,
  description     text,
  is_active       boolean not null default true
);

-- The speech order. Position drives the timer and the ballot layout.
create table format_speeches (
  id              uuid primary key default gen_random_uuid(),
  format_id       uuid not null references formats(id) on delete cascade,
  position        int  not null,                 -- 1..n, order of delivery
  label           text not null,                 -- 'Prime Minister'
  short_label     text not null,                 -- 'PM'
  team_slot       int  not null,                 -- which team delivers it
  speaker_index   int  not null,                 -- 1st or 2nd speaker of that team
  duration_sec    int  not null,                 -- 420 for a 7-min speech
  -- Protected time: window where points of information are barred.
  -- Null means the format has no POIs at all.
  protected_head_sec int,
  protected_tail_sec int,
  is_reply        boolean not null default false,
  unique (format_id, position)
);

-- Scoring criteria. THIS is where the judging rubric lives.
create table format_criteria (
  id            uuid primary key default gen_random_uuid(),
  format_id     uuid not null references formats(id) on delete cascade,
  position      int  not null,
  name          text not null,                   -- 'Matter'
  description   text,                            -- shown to judges as guidance
  weight        numeric(5,2) not null default 1, -- relative contribution
  score_min     numeric(5,2) not null,
  score_max     numeric(5,2) not null,
  -- 'speaker' criteria score individuals, 'team' criteria score the bench
  applies_to    text not null default 'speaker'
                check (applies_to in ('speaker','team')),
  unique (format_id, position)
);

-- Optional descriptors: "28-29 = argument is well-explained but under-weighed"
-- Gives judges concrete anchors instead of a naked number line.
create table criterion_bands (
  id            uuid primary key default gen_random_uuid(),
  criterion_id  uuid not null references format_criteria(id) on delete cascade,
  low           numeric(5,2) not null,
  high          numeric(5,2) not null,
  label         text not null,
  descriptor    text not null
);

-- ------------------------------------------------------------
-- Tournaments and rounds
-- ------------------------------------------------------------

create table tournaments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  format_id   uuid not null references formats(id),
  host        text,
  starts_on   date,
  ends_on     date,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create table teams (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  name          text not null,
  institution   text,
  unique (tournament_id, name)
);

create table team_members (
  team_id    uuid not null references teams(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  speaker_index int not null,
  primary key (team_id, profile_id)
);

create type round_stage as enum ('prelim','partial_elim','quarter','semi','final');
create type round_status as enum ('draft','scheduled','live','judging','completed');

create table rounds (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  sequence      int not null,
  stage         round_stage not null default 'prelim',
  motion        text not null,
  info_slide    text,
  room          text,
  starts_at     timestamptz,
  status        round_status not null default 'draft',
  -- Live timer state, so a reconnecting judge lands mid-speech correctly.
  active_speech_position int,
  speech_started_at      timestamptz,
  unique (tournament_id, sequence)
);

-- Which team sits in which slot this round (Opening Gov, Closing Opp, ...)
create table round_teams (
  round_id  uuid not null references rounds(id) on delete cascade,
  team_id   uuid not null references teams(id) on delete cascade,
  team_slot int not null,
  primary key (round_id, team_id),
  unique (round_id, team_slot)
);

create table round_judges (
  round_id   uuid not null references rounds(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  is_chair   boolean not null default false,
  primary key (round_id, profile_id)
);

-- ------------------------------------------------------------
-- Ballots — one per judge per round
-- ------------------------------------------------------------

create type ballot_status as enum ('open','submitted','confirmed');

create table ballots (
  id          uuid primary key default gen_random_uuid(),
  round_id    uuid not null references rounds(id) on delete cascade,
  judge_id    uuid not null references profiles(id) on delete cascade,
  status      ballot_status not null default 'open',
  reasoning   text,                     -- oral adjudication notes
  submitted_at timestamptz,
  unique (round_id, judge_id)
);

create table ballot_scores (
  id            uuid primary key default gen_random_uuid(),
  ballot_id     uuid not null references ballots(id) on delete cascade,
  criterion_id  uuid not null references format_criteria(id),
  -- speaker-level criteria fill profile_id; team-level fill team_id
  profile_id    uuid references profiles(id),
  team_id       uuid references teams(id),
  score         numeric(5,2) not null,
  note          text,
  check (profile_id is not null or team_id is not null)
);

create table ballot_rankings (
  ballot_id uuid not null references ballots(id) on delete cascade,
  team_id   uuid not null references teams(id) on delete cascade,
  rank      int not null,
  primary key (ballot_id, team_id),
  unique (ballot_id, rank)
);

-- Per-speech feedback the debater sees after the round closes.
create table speech_feedback (
  id         uuid primary key default gen_random_uuid(),
  ballot_id  uuid not null references ballots(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  strengths  text,
  improvements text,
  unique (ballot_id, profile_id)
);

create index on ballots (round_id);
create index on ballot_scores (ballot_id);
create index on rounds (tournament_id, status);

-- ------------------------------------------------------------
-- Aggregates
-- ------------------------------------------------------------

-- Averages across the panel. A 3-judge panel produces 3 ballots;
-- the debater should see the mean, not one judge's opinion.
create view round_speaker_totals as
select
  b.round_id,
  s.profile_id,
  round(avg(s.score), 2) as avg_score,
  count(distinct b.id)   as ballot_count
from ballot_scores s
join ballots b on b.id = s.ballot_id
where b.status <> 'open' and s.profile_id is not null
group by b.round_id, s.profile_id;

create view round_team_results as
select
  b.round_id,
  r.team_id,
  round(avg(r.rank), 2) as avg_rank,
  count(*)              as ballots_counted
from ballot_rankings r
join ballots b on b.id = r.ballot_id
where b.status <> 'open'
group by b.round_id, r.team_id;

-- ============================================================
-- Row Level Security
-- ============================================================
-- The rule that matters: a judge must never read another judge's
-- ballot while the round is open. Panels are meant to reach
-- conclusions independently.
-- ============================================================

alter table profiles       enable row level security;
alter table ballots        enable row level security;
alter table ballot_scores  enable row level security;
alter table ballot_rankings enable row level security;
alter table speech_feedback enable row level security;

create policy "profiles readable by authenticated"
  on profiles for select using (auth.role() = 'authenticated');

create policy "own profile editable"
  on profiles for update using (id = auth.uid());

-- A judge sees only their own ballot until the round completes.
create policy "judge reads own ballot"
  on ballots for select using (
    judge_id = auth.uid()
    or exists (
      select 1 from rounds rd
      where rd.id = ballots.round_id and rd.status = 'completed'
    )
  );

create policy "judge writes own open ballot"
  on ballots for update using (
    judge_id = auth.uid() and status = 'open'
  );

create policy "scores follow ballot visibility"
  on ballot_scores for select using (
    exists (
      select 1 from ballots b
      where b.id = ballot_scores.ballot_id
        and (b.judge_id = auth.uid()
             or exists (select 1 from rounds rd
                        where rd.id = b.round_id and rd.status = 'completed'))
    )
  );

create policy "scores writable on own open ballot"
  on ballot_scores for all using (
    exists (
      select 1 from ballots b
      where b.id = ballot_scores.ballot_id
        and b.judge_id = auth.uid() and b.status = 'open'
    )
  );

create policy "rankings follow ballot visibility"
  on ballot_rankings for select using (
    exists (
      select 1 from ballots b
      where b.id = ballot_rankings.ballot_id
        and (b.judge_id = auth.uid()
             or exists (select 1 from rounds rd
                        where rd.id = b.round_id and rd.status = 'completed'))
    )
  );

-- Debaters read feedback written about them, once the round closes.
create policy "debater reads own feedback"
  on speech_feedback for select using (
    profile_id = auth.uid()
    or exists (
      select 1 from ballots b
      where b.id = speech_feedback.ballot_id and b.judge_id = auth.uid()
    )
  );

-- ============================================================
-- Seed: British Parliamentary
-- ============================================================
-- Placeholder criteria and bands. Replace the format_criteria and
-- criterion_bands rows below with the rubric from your own
-- criteria document — no other table needs to change.
-- ============================================================

insert into formats
  (id, name, short_name, team_count, speakers_per_team,
   score_min, score_max, score_step, uses_ranking, description)
values
  ('11111111-1111-1111-1111-111111111111',
   'British Parliamentary', 'BP', 4, 2, 50, 100, 1, true,
   'Four teams, two benches. Teams are ranked first through fourth.');

insert into format_speeches
  (format_id, position, label, short_label, team_slot, speaker_index,
   duration_sec, protected_head_sec, protected_tail_sec)
values
  ('11111111-1111-1111-1111-111111111111', 1, 'Prime Minister',            'PM',  1, 1, 420, 60, 60),
  ('11111111-1111-1111-1111-111111111111', 2, 'Leader of Opposition',      'LO',  2, 1, 420, 60, 60),
  ('11111111-1111-1111-1111-111111111111', 3, 'Deputy Prime Minister',     'DPM', 1, 2, 420, 60, 60),
  ('11111111-1111-1111-1111-111111111111', 4, 'Deputy Leader of Opposition','DLO', 2, 2, 420, 60, 60),
  ('11111111-1111-1111-1111-111111111111', 5, 'Member for Government',     'MG',  3, 1, 420, 60, 60),
  ('11111111-1111-1111-1111-111111111111', 6, 'Member for Opposition',     'MO',  4, 1, 420, 60, 60),
  ('11111111-1111-1111-1111-111111111111', 7, 'Government Whip',           'GW',  3, 2, 420, 60, 60),
  ('11111111-1111-1111-1111-111111111111', 8, 'Opposition Whip',           'OW',  4, 2, 420, 60, 60);

insert into format_criteria
  (id, format_id, position, name, description, weight, score_min, score_max)
values
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 1, 'Matter',
   'Substance of the argument: is the claim explained, warranted, and weighed against what the other side said?',
   1, 0, 40),
  ('aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111', 2, 'Manner',
   'Delivery: clarity, pace, command of the room, handling of points of information.',
   1, 0, 30),
  ('aaaaaaaa-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111', 3, 'Method',
   'Structure and role fulfilment: did the speech do the job its position required?',
   1, 0, 30);

insert into criterion_bands (criterion_id, low, high, label, descriptor) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 34, 40, 'Excellent',
   'Arguments are tightly warranted and actively weighed against the strongest opposing case.'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 26, 33, 'Strong',
   'Claims are explained and mostly warranted; weighing is present but incomplete.'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 18, 25, 'Competent',
   'Arguments are asserted with some explanation; little engagement with rebuttal.'),
  ('aaaaaaaa-0000-0000-0000-000000000001',  0, 17, 'Developing',
   'Claims are largely unwarranted or irrelevant to the motion.');

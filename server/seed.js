/**
 * Creates the schema and loads starter data.
 * Safe to run repeatedly — it bails if a format already exists.
 *
 *   npm run seed
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('./db');

const now = () => new Date().toISOString();
const id = () => randomUUID();

// ---------------------------------------------------------------
// Formats. Replace the `criteria` blocks with your own rubric and
// nothing else in the codebase needs to change.
// ---------------------------------------------------------------

const FORMATS = [
  {
    name: 'British Parliamentary',
    short_name: 'BP',
    team_count: 4,
    speakers_per_team: 2,
    uses_ranking: 1,
    description: 'Four teams across two benches. Teams are ranked first through fourth.',
    speeches: [
      ['Prime Minister', 'PM', 1, 1, 420, 60, 60],
      ['Leader of Opposition', 'LO', 2, 1, 420, 60, 60],
      ['Deputy Prime Minister', 'DPM', 1, 2, 420, 60, 60],
      ['Deputy Leader of Opposition', 'DLO', 2, 2, 420, 60, 60],
      ['Member for Government', 'MG', 3, 1, 420, 60, 60],
      ['Member for Opposition', 'MO', 4, 1, 420, 60, 60],
      ['Government Whip', 'GW', 3, 2, 420, 60, 60],
      ['Opposition Whip', 'OW', 4, 2, 420, 60, 60],
    ],
    criteria: [
      {
        name: 'Matter', max: 40, def: 28,
        description: 'Substance of the argument: is the claim explained, warranted, and weighed against what the other side actually said?',
        bands: [
          [34, 40, 'Excellent', 'Arguments are tightly warranted and actively weighed against the strongest opposing case.'],
          [26, 33, 'Strong', 'Claims are explained and mostly warranted; weighing is present but incomplete.'],
          [18, 25, 'Competent', 'Arguments are asserted with some explanation; little engagement with rebuttal.'],
          [0, 17, 'Developing', 'Claims are largely unwarranted or drift from the motion.'],
        ],
      },
      {
        name: 'Manner', max: 30, def: 21,
        description: 'Delivery: clarity, pace, command of the room, and how points of information were taken and handled.',
        bands: [
          [26, 30, 'Excellent', 'Fully in command; points of information absorbed and turned to advantage.'],
          [19, 25, 'Strong', 'Clear and persuasive; POIs handled without losing the thread.'],
          [13, 18, 'Competent', 'Audible and organised, though delivery undercuts the content at times.'],
          [0, 12, 'Developing', 'Delivery obscures the argument.'],
        ],
      },
      {
        name: 'Method', max: 30, def: 21,
        description: 'Structure and role fulfilment: did this speech do the job its position on the table required?',
        bands: [
          [26, 30, 'Excellent', 'Signposted throughout and fully discharges the burdens of the role.'],
          [19, 25, 'Strong', 'Clear structure; role largely fulfilled with minor gaps.'],
          [13, 18, 'Competent', 'Followable, but the role is only partly discharged.'],
          [0, 12, 'Developing', 'Little structure; role burdens unmet.'],
        ],
      },
    ],
  },
  {
    name: 'World Schools',
    short_name: 'WSDC',
    team_count: 2,
    speakers_per_team: 3,
    uses_ranking: 0,
    description: 'Two teams of three, plus reply speeches. A winner is declared rather than a ranking.',
    speeches: [
      ['First Proposition', '1P', 1, 1, 480, 60, 60],
      ['First Opposition', '1O', 2, 1, 480, 60, 60],
      ['Second Proposition', '2P', 1, 2, 480, 60, 60],
      ['Second Opposition', '2O', 2, 2, 480, 60, 60],
      ['Third Proposition', '3P', 1, 3, 480, 60, 60],
      ['Third Opposition', '3O', 2, 3, 480, 60, 60],
      ['Opposition Reply', 'OR', 2, 1, 240, 0, 0],
      ['Proposition Reply', 'PR', 1, 1, 240, 0, 0],
    ],
    criteria: [
      {
        name: 'Content', max: 40, def: 28,
        description: 'The arguments themselves, independent of how well they were delivered.',
        bands: [
          [34, 40, 'Excellent', 'Arguments are substantive, well-evidenced, and directly clash with the opposing case.'],
          [26, 33, 'Strong', 'Solid arguments with reasonable support; clash is present.'],
          [18, 25, 'Competent', 'Arguments are relevant but thinly supported.'],
          [0, 17, 'Developing', 'Arguments are unclear or largely unsupported.'],
        ],
      },
      {
        name: 'Style', max: 40, def: 28,
        description: 'How the speech was delivered: voice, pace, eye contact, and use of language.',
        bands: [
          [34, 40, 'Excellent', 'Compelling and controlled delivery that carries the argument.'],
          [26, 33, 'Strong', 'Confident and clear throughout.'],
          [18, 25, 'Competent', 'Understandable, with lapses in pace or clarity.'],
          [0, 17, 'Developing', 'Delivery consistently gets in the way.'],
        ],
      },
      {
        name: 'Strategy', max: 20, def: 14,
        description: 'Choices about what to prioritise: time allocation, structure, and understanding of the issues that matter.',
        bands: [
          [17, 20, 'Excellent', 'Time and emphasis land exactly on the issues that decide the round.'],
          [13, 16, 'Strong', 'Sound prioritisation with minor misallocation.'],
          [9, 12, 'Competent', 'Some awareness of key issues, but time is spent unevenly.'],
          [0, 8, 'Developing', 'Little sense of which issues matter.'],
        ],
      },
    ],
  },
];

const DEMO_USERS = [
  ['admin@veridict.local', 'admin1234', 'Tab Room', 'admin'],
  ['judge@veridict.local', 'judge1234', 'Ade Bakare', 'judge'],
  ['judge2@veridict.local', 'judge1234', 'Miriam Osei', 'judge'],
  ['debater@veridict.local', 'debate1234', 'Amara Okonkwo', 'debater'],
];

const DEMO_TEAMS = [
  ['Trinity A', 'Trinity College'],
  ['Ashworth B', 'Ashworth University'],
  ['Northfield A', 'Northfield College'],
  ['Trinity C', 'Trinity College'],
];

const DEMO_SPEAKERS = [
  'Amara Okonkwo', 'Sofia Marchetti',
  'Daniel Reyes', 'Kwame Mensah',
  'Priya Nair', 'Elena Vasquez',
  'Tobias Lund', 'Jonah Abiodun',
];

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(schema);
  console.log('Schema ready.');

  const existing = await db.get('SELECT id FROM formats LIMIT 1');
  if (existing) {
    console.log('Data already present — nothing to seed.');
    console.log('Delete db/veridict.sqlite to start over.');
    return;
  }

  // -------- formats --------
  const formatIds = {};
  for (const f of FORMATS) {
    const fid = id();
    formatIds[f.short_name] = fid;
    await db.run(
      `INSERT INTO formats (id,name,short_name,team_count,speakers_per_team,uses_ranking,description)
       VALUES (?,?,?,?,?,?,?)`,
      [fid, f.name, f.short_name, f.team_count, f.speakers_per_team, f.uses_ranking, f.description]
    );

    for (let i = 0; i < f.speeches.length; i++) {
      const [label, short, slot, sidx, dur, ph, pt] = f.speeches[i];
      await db.run(
        `INSERT INTO format_speeches
         (id,format_id,position,label,short_label,team_slot,speaker_index,duration_sec,protected_head_sec,protected_tail_sec)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id(), fid, i + 1, label, short, slot, sidx, dur, ph, pt]
      );
    }

    for (let i = 0; i < f.criteria.length; i++) {
      const c = f.criteria[i];
      const cid = id();
      await db.run(
        `INSERT INTO format_criteria
         (id,format_id,position,name,description,score_min,score_max,default_val)
         VALUES (?,?,?,?,?,?,?,?)`,
        [cid, fid, i + 1, c.name, c.description, 0, c.max, c.def]
      );
      for (const [low, high, label, desc] of c.bands) {
        await db.run(
          `INSERT INTO criterion_bands (id,criterion_id,low,high,label,descriptor)
           VALUES (?,?,?,?,?,?)`,
          [id(), cid, low, high, label, desc]
        );
      }
    }
    console.log(`Format loaded: ${f.name}`);
  }

  // -------- users --------
  const userIds = {};
  for (const [email, pw, name, role] of DEMO_USERS) {
    const uid = id();
    userIds[email] = uid;
    await db.run(
      `INSERT INTO users (id,email,password_hash,display_name,institution,role,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [uid, email, bcrypt.hashSync(pw, 10), name, 'Veridict Demo', role, now()]
    );
  }

  // speaker accounts, so a round has real people in it
  const speakerIds = [];
  for (const name of DEMO_SPEAKERS) {
    const uid = id();
    speakerIds.push(uid);
    const email = name.toLowerCase().replace(/[^a-z]/g, '.') + '@veridict.local';
    await db.run(
      `INSERT INTO users (id,email,password_hash,display_name,institution,role,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [uid, email, bcrypt.hashSync('debate1234', 10), name, 'Veridict Demo', 'debater', now()]
    );
  }
  console.log('Users created.');

  // -------- demo tournament --------
  const tid = id();
  await db.run(
    `INSERT INTO tournaments (id,name,format_id,host,created_by,created_at)
     VALUES (?,?,?,?,?,?)`,
    [tid, 'Michaelmas Intervarsity', formatIds.BP, 'Trinity Debating Union',
     userIds['admin@veridict.local'], now()]
  );

  const teamIds = [];
  for (let i = 0; i < DEMO_TEAMS.length; i++) {
    const teamId = id();
    teamIds.push(teamId);
    await db.run(`INSERT INTO teams (id,tournament_id,name,institution) VALUES (?,?,?,?)`,
      [teamId, tid, DEMO_TEAMS[i][0], DEMO_TEAMS[i][1]]);
    await db.run(`INSERT INTO team_members (team_id,user_id,speaker_index) VALUES (?,?,?)`,
      [teamId, speakerIds[i * 2], 1]);
    await db.run(`INSERT INTO team_members (team_id,user_id,speaker_index) VALUES (?,?,?)`,
      [teamId, speakerIds[i * 2 + 1], 2]);
  }

  const rid = id();
  await db.run(
    `INSERT INTO rounds (id,tournament_id,sequence,stage,motion,room,status,active_speech_position)
     VALUES (?,?,?,?,?,?,?,?)`,
    [rid, tid, 1, 'prelim',
     'This house would abolish unpaid internships in all sectors',
     'Room B12', 'live', 1]
  );
  for (let i = 0; i < teamIds.length; i++) {
    await db.run(`INSERT INTO round_teams (round_id,team_id,team_slot) VALUES (?,?,?)`,
      [rid, teamIds[i], i + 1]);
  }
  await db.run(`INSERT INTO round_judges (round_id,user_id,is_chair) VALUES (?,?,?)`,
    [rid, userIds['judge@veridict.local'], 1]);
  await db.run(`INSERT INTO round_judges (round_id,user_id,is_chair) VALUES (?,?,?)`,
    [rid, userIds['judge2@veridict.local'], 0]);

  console.log('Demo tournament created with one live round.\n');
  console.log('Sign in with any of these:');
  for (const [email, pw, , role] of DEMO_USERS) {
    console.log(`  ${role.padEnd(8)} ${email.padEnd(26)} ${pw}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

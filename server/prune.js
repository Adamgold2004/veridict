/* Deletes recordings past their retention date.
   Run on a schedule:  0 3 * * *  cd /path/to/veridict && npm run prune */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const db = require('./db');

const STORE = process.env.RECORDING_DIR || path.join(__dirname, '..', 'storage');

(async () => {
  const now = new Date().toISOString();
  const expired = await db.all(
    'SELECT id, filename FROM recordings WHERE expires_at IS NOT NULL AND expires_at < ?',
    [now]
  );

  for (const r of expired) {
    await fs.promises.unlink(path.join(STORE, r.filename)).catch(() => {});
    await db.run('DELETE FROM recordings WHERE id = ?', [r.id]);
  }

  console.log(`Pruned ${expired.length} expired recording(s).`);

  // Report anything on disk with no database row, which would otherwise
  // sit there consuming quota invisibly.
  const known = new Set((await db.all('SELECT filename FROM recordings')).map(r => r.filename));
  const onDisk = fs.existsSync(STORE) ? fs.readdirSync(STORE) : [];
  const orphans = onDisk.filter(f => !known.has(f));
  if (orphans.length) {
    for (const f of orphans) await fs.promises.unlink(path.join(STORE, f)).catch(() => {});
    console.log(`Removed ${orphans.length} orphaned file(s).`);
  }
  process.exit(0);
})();

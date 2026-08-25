const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (_req, res) => {
  const rows = await db.all('SELECT * FROM formats ORDER BY name');
  res.json({ formats: rows });
});

/**
 * The whole shape of a format in one call: speeches for the timer,
 * criteria for the ballot, bands for the descriptors.
 * The judging UI needs all three before it can render anything.
 */
router.get('/:id', async (req, res) => {
  const format = await db.get('SELECT * FROM formats WHERE id = ?', [req.params.id]);
  if (!format) return res.status(404).json({ error: 'No such format.' });

  const speeches = await db.all(
    'SELECT * FROM format_speeches WHERE format_id = ? ORDER BY position',
    [format.id]
  );
  const criteria = await db.all(
    'SELECT * FROM format_criteria WHERE format_id = ? ORDER BY position',
    [format.id]
  );

  for (const c of criteria) {
    c.bands = await db.all(
      'SELECT low,high,label,descriptor FROM criterion_bands WHERE criterion_id = ? ORDER BY low DESC',
      [c.id]
    );
  }

  res.json({ format, speeches, criteria });
});

module.exports = router;

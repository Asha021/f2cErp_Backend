const express = require('express');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit/deletions
router.get('/deletions', verifyToken, async (req, res) => {
  if (req.user.role !== 'superadmin' && req.user.role !== 'super_admin' && req.user.role !== 'admin') {
     return res.status(403).json({ success: false, message: 'Forbidden: Super Admin only' });
  }

  try {
    const [logs] = await pool.query(`
      SELECT a.log_id as id, a.action, a.description, a.created_at, u.first_name, u.last_name, u.email
      FROM activity_logs a
      JOIN users u ON a.user_id = u.user_id
      WHERE a.action = 'delete_po'
      ORDER BY a.created_at DESC
    `);
    res.json({ success: true, logs });
  } catch (err) {
    console.error('Error fetching deletion logs:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/audit/deletions/:id
router.delete('/deletions/:id', verifyToken, async (req, res) => {
  if (req.user.role !== 'superadmin' && req.user.role !== 'super_admin' && req.user.role !== 'admin') {
     return res.status(403).json({ success: false, message: 'Forbidden: Super Admin only' });
  }

  try {
    await pool.query('DELETE FROM activity_logs WHERE log_id = ?', [req.params.id]);
    res.json({ success: true, message: 'Log deleted successfully' });
  } catch (err) {
    console.error('Error deleting log:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

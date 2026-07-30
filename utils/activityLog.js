const pool = require('../config/db');

// Mirrors the original PHP activity_logs usage (admin/dashboard.php)
async function logActivity({ company_id = null, user_id = null, action, description }) {
  try {
    await pool.query(
      'INSERT INTO activity_logs (company_id, user_id, action, description) VALUES (?, ?, ?, ?)',
      [company_id, user_id, action, description]
    );
  } catch (err) {
    console.error('activity log failed:', err.message);
  }
}

module.exports = { logActivity };

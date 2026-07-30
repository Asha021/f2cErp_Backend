const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/dashboard/superadmin -> admin/dashboard.php stats
router.get('/superadmin', verifyToken, requireSuperAdmin, async (req, res) => {
  const [[companiesCount]] = await pool.query('SELECT COUNT(*) as count FROM companies');
  const [[usersCount]] = await pool.query('SELECT COUNT(*) as count FROM users');
  const [[activeCompaniesCount]] = await pool.query("SELECT COUNT(*) as count FROM companies WHERE status = 'active'");
  const [recentActivities] = await pool.query(`
    SELECT l.*, u.username
    FROM activity_logs l
    LEFT JOIN users u ON l.user_id = u.user_id
    ORDER BY l.created_at DESC
    LIMIT 5
  `);

  res.json({
    success: true,
    stats: {
      total_companies: companiesCount.count,
      total_users: usersCount.count,
      active_companies: activeCompaniesCount.count,
    },
    recent_activities: recentActivities,
  });
});

// GET /api/dashboard/user -> dashboard.php stats (basic real counts instead of hardcoded placeholders)
router.get('/user', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;

  const [[itemsCount]] = await pool.query('SELECT COUNT(*) as count FROM items WHERE company_id = ?', [company_id]);
  const [[poCount]] = await pool.query('SELECT COUNT(*) as count FROM purchase_orders WHERE company_id = ?', [company_id]);
  const [[salesCount]] = await pool.query('SELECT COUNT(*) as count FROM sales WHERE company_id = ?', [company_id]);
  const [[companyRows]] = await pool.query('SELECT company_name FROM companies WHERE company_id = ?', [company_id]);
  const [[pendingPoCount]] = await pool.query(
    "SELECT COUNT(*) as count FROM purchase_orders WHERE company_id = ? AND status IN ('draft','sent')",
    [company_id]
  );

  res.json({
    success: true,
    stats: {
      company_name: companyRows ? companyRows.company_name : '',
      total_items: itemsCount.count,
      total_purchase_orders: poCount.count,
      total_sales: salesCount.count,
      pending_purchase_orders: pendingPoCount.count,
    },
  });
});

module.exports = router;

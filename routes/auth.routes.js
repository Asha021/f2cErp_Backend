const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const router = express.Router();

// POST /api/auth/login  -> mirrors login.php + includes/auth.php Auth::login()
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    if (user.status === 'inactive') {
      return res.status(403).json({ success: false, message: 'Your account is inactive. Contact your administrator.' });
    }

    const payload = {
      user_id: user.user_id,
      username: user.username,
      role: user.role,
      company_id: user.company_id,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    });

    await logActivity({
      company_id: user.company_id,
      user_id: user.user_id,
      action: 'login',
      description: `${user.username} logged in`,
    });

    return res.json({
      success: true,
      token,
      user: {
        user_id: user.user_id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        company_id: user.company_id,
      },
    });
  } catch (err) {
    require('fs').appendFileSync('error.log', err.stack + '\n');
    console.error(err);
    return res.status(500).json({ success: false, message: 'Database error occurred' });
  }
});

// GET /api/auth/me -> current logged in user + company (used for dashboard.php equivalent)
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [userRows] = await pool.query('SELECT * FROM users WHERE user_id = ?', [req.user.user_id]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    delete user.password;

    let company = null;
    if (user.company_id) {
      const [companyRows] = await pool.query('SELECT * FROM companies WHERE company_id = ?', [user.company_id]);
      company = companyRows[0] || null;
      if (company) delete company.smtp_password;
    }

    res.json({ success: true, user, company });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/logout -> stateless JWT, client just discards token.
// Kept for parity + activity logging like logout.php did.
router.post('/logout', verifyToken, async (req, res) => {
  await logActivity({
    company_id: req.user.company_id,
    user_id: req.user.user_id,
    action: 'logout',
    description: `${req.user.username} logged out`,
  });
  res.json({ success: true, message: 'Logged out' });
});

module.exports = router;

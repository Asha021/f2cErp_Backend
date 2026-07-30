const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { verifyToken, requireSuperAdmin } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const router = express.Router();

// GET /api/users -> admin/users.php listing
router.get('/', verifyToken, requireSuperAdmin, async (req, res) => {
  const [users] = await pool.query(`
    SELECT u.user_id, u.username, u.email, u.first_name, u.last_name, u.role,
           u.company_id, u.status, u.created_at, c.company_name
    FROM users u
    LEFT JOIN companies c ON u.company_id = c.company_id
    ORDER BY u.created_at DESC
  `);
  res.json({ success: true, users });
});

// POST /api/users -> admin/actions/add_user.php
router.post('/', verifyToken, requireSuperAdmin, async (req, res) => {
  const { username, password, email, first_name, last_name, role, company_id } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, password, email, first_name, last_name, role, company_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, hashed, email, first_name, last_name, role, company_id]
    );
    await logActivity({
      company_id,
      user_id: req.user.user_id,
      action: 'add_user',
      description: `User "${username}" added`,
    });
    res.json({ success: true, message: 'User added successfully!' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error adding user: ' + err.message });
  }
});

// PATCH /api/users/:id/status -> admin/actions/toggle_user_status.php
router.patch('/:id/status', verifyToken, requireSuperAdmin, async (req, res) => {
  const { new_status } = req.body;
  try {
    await pool.query('UPDATE users SET status = ? WHERE user_id = ?', [new_status, req.params.id]);
    res.json({ success: true, message: 'User status updated successfully!' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error updating user status: ' + err.message });
  }
});

// PUT /api/users/:id -> edit_user.php
router.put('/:id', verifyToken, requireSuperAdmin, async (req, res) => {
  const { username, password, email, first_name, last_name, role, company_id, status } = req.body;
  try {
    let sql = 'UPDATE users SET username=?, email=?, first_name=?, last_name=?, role=?, company_id=?, status=?';
    let params = [username, email, first_name, last_name, role, company_id, status];
    
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      sql += ', password=?';
      params.push(hashed);
    }
    
    sql += ' WHERE user_id=?';
    params.push(req.params.id);

    await pool.query(sql, params);
    res.json({ success: true, message: 'User updated successfully!' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error updating user: ' + err.message });
  }
});

module.exports = router;

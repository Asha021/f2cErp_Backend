const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireSuperAdmin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const router = express.Router();

// GET /api/companies -> admin/companies.php listing (superadmin only)
router.get('/', verifyToken, requireSuperAdmin, async (req, res) => {
  const [companies] = await pool.query('SELECT * FROM companies ORDER BY created_at DESC');
  res.json({ success: true, companies });
});

// GET /api/companies/active -> used to populate "Company" dropdown (admin/users.php)
router.get('/active', verifyToken, requireSuperAdmin, async (req, res) => {
  const [companies] = await pool.query(
    "SELECT company_id, company_name FROM companies WHERE status = 'active'"
  );
  res.json({ success: true, companies });
});

// GET /api/companies/:id -> companies/edit_company.php
router.get('/:id', verifyToken, requireAdmin, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM companies WHERE company_id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Company not found' });
  const company = rows[0];
  delete company.smtp_password;
  res.json({ success: true, company });
});

// POST /api/companies -> admin/actions/add_company.php
router.post('/', verifyToken, requireSuperAdmin, async (req, res) => {
  const { company_code, company_name, email, contact_number, address } = req.body;
  try {
    const [result] = await pool.query(
      `INSERT INTO companies (company_code, company_name, email, contact_number, address)
       VALUES (?, ?, ?, ?, ?)`,
      [company_code, company_name, email, contact_number, address]
    );
    const newCompanyId = result.insertId;

    // Seed default workflow template, stages, and working days
    const [tempRes] = await pool.query(
      'INSERT INTO workflow_templates (company_id, name, description) VALUES (?, ?, ?)',
      [newCompanyId, 'Default Template', 'Automatically generated template']
    );

    const [verRes] = await pool.query(
      'INSERT INTO workflow_template_versions (template_id, version_number, is_active) VALUES (?, ?, ?)',
      [tempRes.insertId, 1, true]
    );

    const versionId = verRes.insertId;
    const defaultStages = ['Raw Material', 'Fabrication', 'Polishing', 'Packing', 'Inspection'];
    for (let i = 0; i < defaultStages.length; i++) {
      await pool.query(
        'INSERT INTO production_stages (company_id, template_version_id, stage_name, order_index, color) VALUES (?, ?, ?, ?, ?)',
        [newCompanyId, versionId, defaultStages[i], i + 1, '#4F46E5']
      );
    }

    const days = [
      { d: 0, w: false }, { d: 1, w: true }, { d: 2, w: true }, { d: 3, w: true },
      { d: 4, w: true }, { d: 5, w: true }, { d: 6, w: false }
    ];
    for (const d of days) {
      await pool.query(
        'INSERT INTO working_days (company_id, day_of_week, is_working) VALUES (?, ?, ?)',
        [newCompanyId, d.d, d.w]
      );
    }

    await logActivity({
      user_id: req.user.user_id,
      action: 'add_company',
      description: `Company "${company_name}" added`,
    });

    res.json({ success: true, message: 'Company added successfully!' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error adding company: ' + err.message });
  }
});

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const upload = multer({ dest: 'uploads/templates/' });

// PUT /api/companies/:id -> companies/update_company.php
router.put('/:id', verifyToken, requireSuperAdmin, upload.single('invoice_template'), async (req, res) => {
  const {
    company_name, company_code, address, contact_number, email, status,
    smtp_host, smtp_email, smtp_password, smtp_port, smtp_from_name,
  } = req.body;

  try {
    let sql = `UPDATE companies SET
        company_name = ?, company_code = ?, address = ?, contact_number = ?, email = ?,
        status = ?, smtp_host = ?, smtp_email = ?, smtp_port = ?, smtp_from_name = ?,
        updated_at = NOW()`;
    let params = [company_name, company_code, address, contact_number, email, status,
      smtp_host, smtp_email, smtp_port || null, smtp_from_name];

    if (smtp_password) {
      sql += `, smtp_password = ?`;
      params.push(smtp_password);
    }

    if (req.file) {
      const templatePath = req.file.path + path.extname(req.file.originalname);
      fs.renameSync(req.file.path, templatePath); // add extension back
      sql += `, invoice_template_path = ?, template_uploaded_at = NOW()`;
      params.push(templatePath);
    }

    sql += ` WHERE company_id = ?`;
    params.push(req.params.id);

    await pool.query(sql, params);
    res.json({ success: true, message: 'Company updated successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error updating company: ' + err.message });
  }
});

// PATCH /api/companies/:id/status -> toggle active/inactive (admin/companies.php)
router.patch('/:id/status', verifyToken, requireSuperAdmin, async (req, res) => {
  const { new_status } = req.body;
  await pool.query('UPDATE companies SET status = ? WHERE company_id = ?', [new_status, req.params.id]);
  res.json({ success: true, message: 'Status updated' });
});

module.exports = router;

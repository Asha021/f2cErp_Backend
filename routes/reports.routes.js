const express = require('express');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// GET /api/reports/balance -> orders/balance_report.php
router.get('/balance', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  try {
    const [orders] = await pool.query(
      `SELECT po.id, po.po_number, po.po_date, po.factory, po.status,
              SUM(pi.quantity * pi.price) AS total_amount
       FROM purchase_orders po
       LEFT JOIN po_items pi ON po.id = pi.po_id
       WHERE po.company_id = ?
       GROUP BY po.id
       ORDER BY po.created_at DESC`,
      [company_id]
    );

    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching balance report: ' + err.message });
  }
});

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const upload = multer({
  dest: 'uploads/reports/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// POST /api/reports/upload -> process_balance_report.php
router.post('/upload', verifyToken, upload.single('document'), async (req, res) => {
  const { po_id, document_type } = req.body;
  if (!po_id || !document_type || !req.file) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    const docPath = req.file.path + path.extname(req.file.originalname);
    fs.renameSync(req.file.path, docPath);

    // Fetch PO to get quantities
    const [po] = await pool.query(`
      SELECT COALESCE(SUM(quantity), 0) as po_quantity 
      FROM po_items WHERE po_id = ?`, [po_id]);

    const po_quantity = po[0] ? po[0].po_quantity : 0;

    await pool.query(
      `INSERT INTO balance_reports (po_id, document_type, document_path, po_quantity, ready_quantity, balance) 
       VALUES (?, ?, ?, ?, 0, ?)`,
      [po_id, document_type, docPath, po_quantity, po_quantity]
    );

    res.json({ success: true, message: 'Document uploaded successfully' });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ success: false, message: 'Failed to upload document' });
  }
});

module.exports = router;

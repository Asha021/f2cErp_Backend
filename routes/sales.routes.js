const express = require('express');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const router = express.Router();

// GET /api/sales -> orders/sales.php listing
router.get('/', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const [rows] = await pool.query(
    `SELECT s.sale_id, s.customer_name, s.sale_date, s.total_amount, s.status, s.created_at
     FROM sales s
     ORDER BY s.created_at DESC`
  );
  res.json({ success: true, sales: rows });
});

// GET /api/sales/:id -> sale + line items
router.get('/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const [saleRows] = await pool.query('SELECT * FROM sales WHERE sale_id = ? AND company_id = ?', [req.params.id, company_id]);
  if (!saleRows[0]) return res.status(404).json({ success: false, message: 'Sale not found' });
  const [items] = await pool.query(
    `SELECT si.sale_item_id, si.item_id, si.quantity, si.unit_price, si.total_price, i.item_name
     FROM sale_items si LEFT JOIN items i ON si.item_id = i.item_id
     WHERE si.sale_id = ?`,
    [req.params.id]
  );
  res.json({ success: true, sale: saleRows[0], items });
});

// POST /api/sales -> create a sale + its line items
router.post('/', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { customer_name, sale_date, items } = req.body; // items: [{item_id, quantity, unit_price}]

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const calculated_total = (items || []).reduce((sum, it) => sum + (it.quantity * it.unit_price), 0);
    const final_total = req.body.total_amount !== undefined ? req.body.total_amount : calculated_total;

    const [result] = await conn.query(
      `INSERT INTO sales (company_id, customer_name, sale_date, total_amount, status, created_by)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [company_id, customer_name, sale_date, final_total, req.user.user_id]
    );
    const sale_id = result.insertId;

    for (const it of items || []) {
      const total_price = it.quantity * it.unit_price;
      await conn.query(
        `INSERT INTO sale_items (sale_id, item_id, quantity, unit_price, total_price)
         VALUES (?, ?, ?, ?, ?)`,
        [sale_id, it.item_id, it.quantity, it.unit_price, total_price]
      );
    }

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'create_sale', description: `Sale for "${customer_name}" created` });
    res.json({ success: true, message: 'Sale created successfully', sale_id });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ success: false, message: 'Error creating sale: ' + err.message });
  } finally {
    conn.release();
  }
});

// DELETE /api/sales/:id -> orders/sales.php (delete_sale)
router.delete('/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM sale_items WHERE sale_id = ?', [req.params.id]);
    await conn.query('DELETE FROM sales WHERE sale_id = ?', [req.params.id]);
    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'delete_sale', description: `Sale #${req.params.id} deleted` });
    res.json({ success: true, message: 'Sale deleted successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ success: false, message: 'Error deleting sale: ' + err.message });
  } finally {
    conn.release();
  }
});
const multer = require('multer');
const xlsx = require('xlsx');
const upload = multer({ dest: 'uploads/' });
const PDFDocument = require('pdfkit');

// GET /api/sales/:id/invoice
router.get('/:id/invoice', verifyToken, async (req, res) => {
  // We need company_id to verify access, but it might not be in req.user if called from window.open without token, 
  // but we fixed verifyToken to read from query.
  const [saleRows] = await pool.query('SELECT * FROM sales WHERE sale_id = ?', [req.params.id]);
  if (!saleRows[0]) return res.status(404).send('Sale not found');
  
  const [items] = await pool.query(
    `SELECT si.quantity, si.unit_price, si.total_price, i.item_name
     FROM sale_items si LEFT JOIN items i ON si.item_id = i.item_id
     WHERE si.sale_id = ?`,
    [req.params.id]
  );
  
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice_${req.params.id}.pdf"`);
  doc.pipe(res);

  doc.fontSize(24).text('INVOICE', { align: 'right' });
  doc.fontSize(10).text(`Invoice #: ${req.params.id}`, { align: 'right' });
  doc.text(`Date: ${new Date(saleRows[0].sale_date).toLocaleDateString()}`, { align: 'right' });
  doc.moveDown();
  doc.fontSize(14).text(`Billed To: ${saleRows[0].customer_name}`);
  doc.moveDown(2);

  doc.fontSize(12).text('Items:', { underline: true });
  doc.moveDown(0.5);
  items.forEach(it => {
    doc.text(`${it.item_name || 'Unknown Item'} - ${it.quantity} x $${it.unit_price} = $${it.total_price}`);
  });
  
  doc.moveDown(2);
  doc.fontSize(14).text(`Total: $${saleRows[0].total_amount}`, { align: 'right' });
  
  doc.end();
});

// GET /api/sales/:id/bol
router.get('/:id/bol', verifyToken, async (req, res) => {
  const [saleRows] = await pool.query('SELECT * FROM sales WHERE sale_id = ?', [req.params.id]);
  if (!saleRows[0]) return res.status(404).send('Sale not found');
  
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="bol_${req.params.id}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).text('BILL OF LADING', { align: 'center' });
  doc.moveDown(2);
  doc.fontSize(12).text(`Order Number: ${req.params.id}`);
  doc.text(`Date: ${new Date(saleRows[0].sale_date).toLocaleDateString()}`);
  doc.moveDown();
  doc.text(`Consignee: ${saleRows[0].customer_name}`);
  doc.moveDown(2);
  doc.text('Carrier Signature: _______________________      Date: ______________');
  
  doc.end();
});

// POST /api/sales/import
router.post('/import', verifyToken, async (req, res) => {
  const { data } = req.body;
  if (!data || !Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ success: false, message: 'No valid data provided' });
  }

  const company_id = req.user.company_id;
  try {
    let imported = 0;
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      for (const row of data) {
        if (!row.customer_name) continue;
        await conn.query(
          `INSERT INTO sales (company_id, customer_name, sale_date, total_amount, status, created_by)
           VALUES (?, ?, ?, ?, 'completed', ?)`,
          [
            company_id, String(row.customer_name), 
            row.sale_date || new Date(), 
            row.total_amount || 0, req.user.user_id
          ]
        );
        imported++;
      }
      if (imported === 0) {
        throw new Error('No valid sales data found.');
      }
      await conn.commit();
      await logActivity({ company_id, user_id: req.user.user_id, action: 'import_sales', description: `Imported ${imported} sales` });
      res.json({ success: true, message: `Successfully imported ${imported} sales` });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error processing data: ' + err.message });
  }
});

const { generateInvoiceDocx } = require('../utils/documentGenerator');

// GET /api/sales/:id/generate-invoice
router.get('/:id/generate-invoice', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const sale_id = req.params.id;
  try {
    const [saleRows] = await pool.query('SELECT * FROM sales WHERE sale_id = ? AND company_id = ?', [sale_id, company_id]);
    if (!saleRows[0]) return res.status(404).json({ success: false, message: 'Sale not found' });
    const [items] = await pool.query(
      `SELECT si.sale_item_id, si.item_id, si.quantity, si.unit_price, si.total_price, i.item_name
       FROM sale_items si LEFT JOIN items i ON si.item_id = i.item_id
       WHERE si.sale_id = ?`,
      [sale_id]
    );
    const [compRows] = await pool.query('SELECT * FROM companies WHERE id = ?', [company_id]);

    const buffer = await generateInvoiceDocx(saleRows[0], items, compRows[0] || {});
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice_${saleRows[0].sale_id}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error generating invoice: ' + err.message });
  }
});

// POST /api/sales/import
router.post('/import', verifyToken, async (req, res) => {
  const { data } = req.body;
  if (!data || !Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ success: false, message: 'No valid data provided' });
  }

  const company_id = req.user.company_id;
  try {
    let imported = 0;
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      for (const row of data) {
        if (!row.customer_name) continue;
        const total = row.total_amount ? Number(row.total_amount) : 0;
        await conn.query(
          `INSERT INTO sales (company_id, customer_name, sale_date, total_amount, status, created_by)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
          [
            company_id, 
            row.customer_name, 
            row.sale_date || new Date(), 
            total,
            req.user.user_id
          ]
        );
        imported++;
      }
      if (imported === 0) {
        throw new Error('No valid sales data found.');
      }
      await conn.commit();
      await logActivity({ company_id, user_id: req.user.user_id, action: 'import_sales', description: `Imported ${imported} sales` });
      res.json({ success: true, message: `Successfully imported ${imported} sales` });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error processing data: ' + err.message });
  }
});

module.exports = router;

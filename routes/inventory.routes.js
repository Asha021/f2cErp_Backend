const express = require('express');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const router = express.Router();

// helper: scope every query to the logged-in user's company (same as $_SESSION['company_id'] in PHP)
function companyIdOf(req) {
  return req.user.company_id;
}

// GET /api/inventory/items -> inventory/items.php
router.get('/items', verifyToken, async (req, res) => {
  const company_id = companyIdOf(req);
  const [items] = await pool.query(
    `SELECT i.*, COALESCE(inv.quantity, 0) AS stock_quantity
     FROM items i
     LEFT JOIN inventory inv ON inv.item_id = i.item_id AND inv.company_id = i.company_id
     WHERE i.company_id = ?
     ORDER BY i.created_at DESC`,
    [company_id]
  );
  res.json({ success: true, items });
});

// GET /api/inventory/items/:id -> inventory/edit_item.php (fetch single)
router.get('/items/:id', verifyToken, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM items WHERE item_id = ? AND company_id = ?',
    [req.params.id, companyIdOf(req)]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Item not found' });
  res.json({ success: true, item: rows[0] });
});

// POST /api/inventory/items -> inventory/add_item.php
router.post('/items', verifyToken, async (req, res) => {
  const company_id = companyIdOf(req);
  const { item_code, item_name, description, hsn_code, category, buy_price, sale_price, unit, additional_info, opening_stock } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO items (company_id, item_code, item_name, description, hsn_code, category, buy_price, sale_price, unit, additional_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [company_id, item_code, item_name, description, hsn_code, category, buy_price || 0, sale_price || 0, unit, additional_info || null]
    );
    const item_id = result.insertId;

    await conn.query(
      `INSERT INTO inventory (company_id, item_id, quantity) VALUES (?, ?, ?)`,
      [company_id, item_id, opening_stock || 0]
    );

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'add_item', description: `Item "${item_name}" added` });
    res.json({ success: true, message: 'Item added successfully', item_id });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ success: false, message: 'Error adding item: ' + err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/inventory/items/:id -> inventory/edit_item.php (save)
router.put('/items/:id', verifyToken, async (req, res) => {
  const company_id = companyIdOf(req);
  const { item_code, item_name, description, hsn_code, category, buy_price, sale_price, unit, additional_info, status } = req.body;
  try {
    await pool.query(
      `UPDATE items SET item_code=?, item_name=?, description=?, hsn_code=?, category=?,
              buy_price=?, sale_price=?, unit=?, additional_info=?, status=?, updated_at=NOW()
       WHERE item_id=? AND company_id=?`,
      [item_code, item_name, description, hsn_code, category, buy_price, sale_price, unit, additional_info, status, req.params.id, company_id]
    );
    res.json({ success: true, message: 'Item updated successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error updating item: ' + err.message });
  }
});

// DELETE /api/inventory/items/:id -> inventory/delete_item.php
router.delete('/items/:id', verifyToken, async (req, res) => {
  const company_id = companyIdOf(req);
  try {
    await pool.query('DELETE FROM inventory WHERE item_id = ? AND company_id = ?', [req.params.id, company_id]);
    await pool.query('DELETE FROM items WHERE item_id = ? AND company_id = ?', [req.params.id, company_id]);
    res.json({ success: true, message: 'Item deleted successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error deleting item: ' + err.message });
  }
});

// POST /api/inventory/stock-adjustment -> inventory/stock_adjustment.php
router.post('/stock-adjustment', verifyToken, async (req, res) => {
  const company_id = companyIdOf(req);
  const { item_id, adjustment_type, quantity, reason } = req.body; // adjustment_type: 'add' | 'reduce'
  const qty = parseInt(quantity, 10) || 0;

  try {
    const [rows] = await pool.query('SELECT quantity FROM inventory WHERE item_id = ? AND company_id = ?', [item_id, company_id]);
    const current = rows[0] ? rows[0].quantity : 0;
    const newQty = adjustment_type === 'add' ? current + qty : current - qty;

    if (rows[0]) {
      await pool.query('UPDATE inventory SET quantity = ?, last_updated = NOW() WHERE item_id = ? AND company_id = ?', [newQty, item_id, company_id]);
    } else {
      await pool.query('INSERT INTO inventory (company_id, item_id, quantity) VALUES (?, ?, ?)', [company_id, item_id, newQty]);
    }

    await logActivity({ company_id, user_id: req.user.user_id, action: 'stock_adjustment', description: `${adjustment_type} ${qty} (reason: ${reason || 'n/a'})` });
    res.json({ success: true, message: 'Stock adjusted successfully', new_quantity: newQty });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Error adjusting stock: ' + err.message });
  }
});

// GET /api/inventory/stock-report -> inventory/stock_report.php
router.get('/stock-report', verifyToken, async (req, res) => {
  const company_id = companyIdOf(req);
  const [report] = await pool.query(
    `SELECT i.item_id, i.item_code, i.item_name, i.category, i.unit, i.buy_price, i.sale_price,
            COALESCE(inv.quantity, 0) AS quantity,
            (COALESCE(inv.quantity, 0) * i.buy_price) AS stock_value
     FROM items i
     LEFT JOIN inventory inv ON inv.item_id = i.item_id AND inv.company_id = i.company_id
     WHERE i.company_id = ? AND i.status = 'active'
     ORDER BY i.item_name`,
    [company_id]
  );
  res.json({ success: true, report });
});

const PDFDocument = require('pdfkit');

// GET /api/inventory/stock-report/export -> inventory/stock_report.php
router.get('/stock-report/export', verifyToken, async (req, res) => {
  const company_id = companyIdOf(req);
  const type = req.query.type;
  
  const [report] = await pool.query(
    `SELECT i.item_id, i.item_code, i.item_name, i.category, i.unit, i.buy_price, i.sale_price,
            COALESCE(inv.quantity, 0) AS quantity,
            (COALESCE(inv.quantity, 0) * i.buy_price) AS stock_value
     FROM items i
     LEFT JOIN inventory inv ON inv.item_id = i.item_id AND inv.company_id = i.company_id
     WHERE i.company_id = ? AND i.status = 'active'
     ORDER BY i.item_name`,
    [company_id]
  );

  if (type === 'excel') {
    const ws_data = [
      ['Item Code', 'Item Name', 'Category', 'Stock Quantity', 'Unit', 'Buy Price', 'Stock Value']
    ];
    report.forEach(item => {
      ws_data.push([item.item_code, item.item_name, item.category, item.quantity, item.unit, item.buy_price, item.stock_value]);
    });
    const ws = xlsx.utils.aoa_to_sheet(ws_data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Stock Report");
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="stock_report.xlsx"');
    return res.send(buffer);
  } else if (type === 'pdf') {
    const doc = new PDFDocument({ margin: 30 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="stock_report.pdf"');
    doc.pipe(res);

    doc.fontSize(20).text('Stock Report', { align: 'center' });
    doc.moveDown();
    
    report.forEach(item => {
      doc.fontSize(12).text(`Item: ${item.item_name} (${item.item_code})`);
      doc.fontSize(10).text(`Stock: ${item.quantity} ${item.unit} | Value: ${item.stock_value}`);
      doc.moveDown(0.5);
    });
    doc.end();
  } else {
    res.status(400).json({ success: false, message: 'Invalid export type' });
  }
});

// POST /api/inventory/import
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
        if (!row.item_code && !row.item_name) continue;
        await conn.query(
          `INSERT INTO items 
           (company_id, item_code, item_name, description, hsn_code, category, buy_price, sale_price, unit, opening_stock, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             item_name=VALUES(item_name), description=VALUES(description), hsn_code=VALUES(hsn_code),
             category=VALUES(category), buy_price=VALUES(buy_price), sale_price=VALUES(sale_price),
             unit=VALUES(unit), opening_stock=VALUES(opening_stock)`,
          [
            company_id, 
            String(row.item_code || `ITM-${Date.now()}-${imported}`), 
            String(row.item_name || 'Unnamed Item'), 
            row.description || '', 
            row.hsn_code || '', 
            row.category || '', 
            parseFloat(row.buy_price) || 0, 
            parseFloat(row.sale_price) || 0, 
            row.unit || 'pcs', 
            parseInt(row.opening_stock) || 0,
            req.user.user_id
          ]
        );
        imported++;
      }
      
      if (imported === 0) {
        throw new Error('No valid inventory item data found.');
      }
      await conn.commit();
      await logActivity({ company_id, user_id: req.user.user_id, action: 'import_items', description: `Imported ${imported} items` });
      res.json({ success: true, message: `Successfully imported ${imported} items` });
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

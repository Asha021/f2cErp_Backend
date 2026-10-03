const express = require('express');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const ExcelJs = require('exceljs');


async function syncToInspectAppHelper(po_id, company_id, conn, req = null) {
  const inspectAppUrl = process.env.INSPECTAPP_API_URL || 'http://localhost/InspectAppBackup/git 28 july/api/import_purchase_order.php';
  const inspectAppToken = process.env.INSPECTAPP_API_TOKEN || 'f2c_secret_token_123';
  try {
    const [poRows] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (!poRows[0]) return { success: false, message: 'PO not found' };
    const po = poRows[0];
    const [erpCompRows] = await conn.query('SELECT * FROM companies WHERE company_id = ?', [company_id]);
    if (!erpCompRows[0]) return { success: false, message: 'ERP Company not found' };
    const erpCompanyName = erpCompRows[0].company_name;
    const [iaCompanies] = await conn.query('SELECT id, company_name, status, subscription_expires_at FROM uaconsu1_inspectapp.ia_companies');
    const normalizeCompanyName = (name) => {
      if (!name) return '';
      return name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ltd|limited|inc|co|corp|consultants|consultant)$/g, '').replace(/s$/g, '');
    };
    const targetNormal = normalizeCompanyName(erpCompanyName);
    let iaCompany = iaCompanies.find(c => normalizeCompanyName(c.company_name) === targetNormal);
    if (!iaCompany) {
      iaCompany = iaCompanies.find(c => {
        const cNormal = normalizeCompanyName(c.company_name);
        return cNormal.length > 1 && targetNormal.length > 1 && (cNormal.includes(targetNormal) || targetNormal.includes(cNormal));
      });
    }
    if (!iaCompany) return { success: false, status: 'not_linked', message: 'Your company is not linked with InspectApp. You can link your InspectApp from here.' };
    if (iaCompany.status !== 'approved' && iaCompany.status !== 'active') return { success: false, status: 'inactive', message: `Your InspectApp account status is '${iaCompany.status}'. Please contact InspectApp admin.` };
    if (iaCompany.subscription_expires_at) {
      const expiryDate = new Date(iaCompany.subscription_expires_at);
      const currentDate = new Date();
      expiryDate.setHours(0, 0, 0, 0);
      currentDate.setHours(0, 0, 0, 0);
      if (expiryDate < currentDate) return { success: false, status: 'expired', message: 'Your InspectApp subscription has expired. Please renew your subscription.' };
    }
    const [items] = await conn.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);
    const payload = {
      erp_po_id: po.id,
      po_number: po.po_number,
      buyer_name: po.buyer || '',
      factory_name: po.factory || '',
      company_id: iaCompany.id,
      items: items.map(item => {
        let l = '', w = '', h = '';
        if (item.size) {
          const parts = item.size.split(/[\*xX]+/).map(p => p.trim());
          if (parts.length >= 1) l = parts[0];
          if (parts.length >= 2) w = parts[1];
          if (parts.length >= 3) h = parts[2];
        }

        const baseUrl = req ? `${req.protocol}://${req.get('host')}` : '';
        const fullImageUrl = item.item_picture
          ? (item.item_picture.startsWith('http') ? item.item_picture : `${baseUrl}${item.item_picture}`)
          : '';

        return {
          erp_item_id: item.id, item_number: item.item_no || '', item_name: item.item_name || '', order_quantity: item.quantity || 0,
          material: item.material || '', finish: item.finish || '', weight: item.weight || '', length: l, width: w, height: h,
          upc: item.upc || '', product_image_url: fullImageUrl, item_picture_url: fullImageUrl, pieces_to_assemble: item.pieces_to_assemble || 0
        };
      })
    };
    const response = await fetch(inspectAppUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${inspectAppToken}` }, body: JSON.stringify(payload)
    });
    const responseData = await response.text();
    let parsedResponse = {};
    try { parsedResponse = JSON.parse(responseData); } catch (e) { parsedResponse = { message: responseData }; }
    if (response.ok && parsedResponse.status === 'success') {
      await conn.query('UPDATE purchase_orders SET sync_status = ?, last_synced_at = NOW() WHERE id = ?', ['Synced', po_id]);
      await conn.query('INSERT INTO sync_logs (erp_po_id, status, response) VALUES (?, ?, ?)', [po_id, 'Synced', JSON.stringify(parsedResponse)]);
      const [[updatedPo]] = await conn.query('SELECT sync_status, last_synced_at FROM purchase_orders WHERE id = ?', [po_id]);
      return { success: true, message: 'Synced to InspectApp successfully', sync_status: updatedPo.sync_status, last_synced_at: updatedPo.last_synced_at };
    } else {
      const errMsg = parsedResponse.message || `HTTP ${response.status}: Unknown error`;
      await conn.query('UPDATE purchase_orders SET sync_status = ?, last_synced_at = NOW() WHERE id = ?', ['Sync Failed', po_id]);
      await conn.query('INSERT INTO sync_logs (erp_po_id, status, response, error) VALUES (?, ?, ?, ?)', [po_id, 'Sync Failed', JSON.stringify(parsedResponse), errMsg]);
      const [[updatedPo]] = await conn.query('SELECT sync_status, last_synced_at FROM purchase_orders WHERE id = ?', [po_id]);
      return { success: false, message: 'Sync failed: ' + errMsg, sync_status: updatedPo.sync_status, last_synced_at: updatedPo.last_synced_at };
    }
  } catch (err) {
    try {
      await conn.query('UPDATE purchase_orders SET sync_status = ?, last_synced_at = NOW() WHERE id = ?', ['Sync Failed', po_id]);
      await conn.query('INSERT INTO sync_logs (erp_po_id, status, error) VALUES (?, ?, ?)', [po_id, 'Sync Failed', err.message]);
    } catch (_) { }
    const [[updatedPo]] = await conn.query('SELECT sync_status, last_synced_at FROM purchase_orders WHERE id = ?', [po_id]).catch(() => [[{}]]);
    return { success: false, message: 'Error syncing to InspectApp: ' + err.message, sync_status: updatedPo?.sync_status, last_synced_at: updatedPo?.last_synced_at };
  }
}

const { logActivity } = require('../utils/activityLog');
const { distributeDates } = require('../utils/workflowUtils');
const bcrypt = require('bcryptjs');
const { sendEmail } = require('../utils/mailer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const fs = require('fs');
const https = require('https');
const http = require('http');
const router = express.Router();


// GET /api/purchase-orders -> orders/purchase.php listing
// router.get('/', verifyToken, async (req, res) => {
//   const company_id = req.user.company_id;
//   try {
//     // Automatically heal any invalid empty/legacy statuses in database
//     await pool.query(
//       "UPDATE purchase_orders SET status = 'in_progress' WHERE (status = '' OR status = 'in_production' OR status = 'confirmed') AND company_id = ?",
//       [company_id]
//     );

//     const [rows] = await pool.query(
//       `SELECT po.*,
//               GROUP_CONCAT(DISTINCT pi.description SEPARATOR ', ') AS items_description,
//               SUM(pi.quantity) AS total_quantity
//        FROM purchase_orders po
//        LEFT JOIN po_items pi ON po.id = pi.po_id
//        WHERE po.company_id = ?
//        GROUP BY po.id
//        ORDER BY po.created_at DESC`,
//       [company_id]
//     );
//     res.json({ success: true, purchase_orders: rows });
//   } catch (err) {
//     res.status(500).json({ success: false, message: err.message });
//   }
// });

// GET /api/purchase-orders -> orders/purchase.php listing
router.get('/', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;

  // Pagination
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 10, 100);
  const offset = (page - 1) * limit;

  try {
    // Automatically heal any invalid empty/legacy statuses in database
    await pool.query(
      `UPDATE purchase_orders
       SET status = 'in_progress'
       WHERE (status = '' OR status = 'in_production' OR status = 'confirmed')
       AND company_id = ?`,
      [company_id]
    );

    // Get paginated purchase orders
    const [rows] = await pool.query(
      `SELECT 
          po.*,
          GROUP_CONCAT(DISTINCT pi.item_no SEPARATOR ', ') AS item_no,
          GROUP_CONCAT(DISTINCT pi.item_name SEPARATOR ', ') AS item_name,
          GROUP_CONCAT(DISTINCT pi.description SEPARATOR ', ') AS items_description,
          MAX(pi.item_picture) AS item_picture,
          SUM(pi.quantity) AS total_quantity
       FROM purchase_orders po
       LEFT JOIN po_items pi ON po.id = pi.po_id
       WHERE po.company_id = ?
       GROUP BY po.id
       ORDER BY po.created_at DESC
       LIMIT ? OFFSET ?`,
      [company_id, limit, offset]
    );

    // Get total records for this company
    const [[countResult]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM purchase_orders
       WHERE company_id = ?`,
      [company_id]
    );

    const total = Number(countResult.total);
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      purchase_orders: rows,
      pagination: {
        total,
        page,
        limit,
        totalPages
      }
    });

  } catch (err) {
    console.error('Error fetching purchase orders:', err);

    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});


// GET /api/purchase-orders/next-po-number
router.get('/next-po-number', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const dateObj = new Date();
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  try {
    const [rows] = await pool.query(
      "SELECT MAX(po_number) as last_po FROM purchase_orders WHERE po_number LIKE ? AND company_id = ?",
      [`PO-${dateStr}-%`, company_id]
    );

    let lastNumber = 0;
    if (rows[0] && rows[0].last_po) {
      const parts = rows[0].last_po.split('-');
      if (parts.length >= 3) {
        lastNumber = parseInt(parts[2], 10) || 0;
      }
    }

    const newPoNumber = `PO-${dateStr}-${String(lastNumber + 1).padStart(3, '0')}`;
    res.json({ success: true, po_number: newPoNumber });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error generating PO number: ' + err.message });
  }
});



// =====================================================================
// GET /api/purchase-orders/summary/pos
// Fetch all POs across all buyers (flat list for PO Wise / Delivery Wise views)
// =====================================================================
router.get('/summary/pos', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { start_date, end_date } = req.query;

  try {
    let dateFilter = '';
    const params = [company_id];
    if (start_date && end_date) {
      dateFilter = 'AND po.po_date BETWEEN ? AND ?';
      params.push(start_date, end_date);
    }

    const [rows] = await pool.query(`
      SELECT
        po.id,
        po.po_number,
        po.po_date,
        po.po_delivery_date,
        po.status,
        po.buyer,
        po.factory,
        po.sync_status,
        po.last_synced_at,
        COALESCE(SUM(pi.quantity * pi.price), 0) AS total_value,
        COALESCE(SUM(pi.quantity), 0) AS total_quantity
      FROM purchase_orders po
      LEFT JOIN po_items pi ON pi.po_id = po.id
      WHERE po.company_id = ? ${dateFilter}
      GROUP BY po.id
      ORDER BY po.po_date DESC
    `, params);

    const pos = rows.map((r) => ({
      id: r.id,
      poNumber: r.po_number,
      poDate: r.po_date,
      deliveryDate: r.po_delivery_date,
      status: r.status,
      buyer: r.buyer,
      factory: r.factory,
      sync_status: r.sync_status,
      last_synced_at: r.last_synced_at,
      totalValue: Number(r.total_value || 0),
      totalQuantity: Number(r.total_quantity || 0),
    }));

    res.json({ success: true, pos });
  } catch (error) {
    console.error('Error fetching all POs:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch purchase orders.' });
  }
});

// =====================================================================
// Add these two routes inside backend/routes/purchaseOrders.routes.js
// Place them ABOVE `router.get('/:id', ...)` to avoid route-order clashes.
// =====================================================================

// ---------------------------------------------------------------------
// LEVEL 1: GET /api/purchase-orders/summary/buyers
// LEVEL 1: GET /api/purchase-orders/summary/dates
// LEVEL 1: GET /api/purchase-orders/summary/items
// Optional query params: ?start_date=2026-08-01&end_date=2026-10-31
// Returns one row per buyer, aggregated across their POs.
// ---------------------------------------------------------------------
router.get('/summary/buyers', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { start_date, end_date } = req.query;

  try {
    let dateFilter = '';
    const params = [company_id];

    if (start_date && end_date) {
      dateFilter = 'AND po.po_date BETWEEN ? AND ?';
      params.push(start_date, end_date);
    }

    const [rows] = await pool.query(`
      SELECT
        po.buyer,
        GROUP_CONCAT(DISTINCT po.po_number SEPARATOR ', ') AS po_numbers,
        COUNT(DISTINCT po.id) AS po_count,
        COALESCE(SUM(pi.quantity * pi.price), 0) AS total_value,
        MIN(po.po_delivery_date) AS nearest_delivery,
        MAX(po.status) AS status
      FROM purchase_orders po
      LEFT JOIN po_items pi ON pi.po_id = po.id
      WHERE po.company_id = ? ${dateFilter}
      GROUP BY po.buyer
      ORDER BY po.buyer ASC
    `, params);

    const buyers = rows.map((r) => ({
      buyer: r.buyer || 'Unknown Buyer',
      poNumbers: r.po_numbers || '',
      poCount: Number(r.po_count || 0),
      totalValue: Number(r.total_value || 0),
      nearestDelivery: r.nearest_delivery,
      status: r.status || 'pending',
    }));

    res.json({ success: true, buyers });
  } catch (error) {
    console.error('Error fetching buyer summary:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch buyer summary.' });
  }
});



router.get('/summary/dates', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { start_date, end_date } = req.query;

  try {
    let dateFilter = '';
    const params = [company_id];
    if (start_date && end_date) {
      dateFilter = 'AND DATE(po.po_date) BETWEEN ? AND ?';
      params.push(start_date, end_date);
    }

    const [rows] = await pool.query(`
      SELECT 
        DATE(po.po_date) as po_date, 
        COUNT(DISTINCT po.id) as po_count, 
        COALESCE(SUM(pi.quantity), 0) as total_quantity, 
        COALESCE(SUM(pi.quantity * pi.price), 0) as total_value
      FROM purchase_orders po
      LEFT JOIN po_items pi ON pi.po_id = po.id
      WHERE po.company_id = ? ${dateFilter}
      GROUP BY DATE(po.po_date) 
      ORDER BY DATE(po.po_date) DESC
    `, params);
    res.json({ success: true, dates: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/summary/items', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { start_date, end_date } = req.query;

  try {
    let query = `
      SELECT
        pi.item_no,
        MAX(pi.item_name) AS item_name,
        MAX(pi.item_picture) AS item_picture,
        COUNT(DISTINCT po.id) AS po_count,
        SUM(pi.quantity) AS total_quantity
      FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.po_id
      WHERE po.company_id = ?
    `;
    const params = [company_id];

    if (start_date && end_date) {
      query += ` AND DATE(po.po_date) BETWEEN ? AND ?`;
      params.push(start_date, end_date);
    }

    query += ` GROUP BY pi.item_no ORDER BY pi.item_no ASC`;

    const [rows] = await pool.query(query, params);
    res.json({ success: true, items: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------
// LEVEL 2: GET /api/purchase-orders/summary/buyers/:buyer/pos
// Optional query params: ?start_date=...&end_date=...
// Returns all POs belonging to a specific buyer.
// NOTE: :buyer is the exact buyer name string (URL-encoded on frontend).
// ---------------------------------------------------------------------
router.get('/summary/buyers/:buyer/pos', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { buyer } = req.params;
  const { start_date, end_date } = req.query;

  try {
    let dateFilter = '';
    const params = [company_id];
    let buyerCondition = 'po.buyer = ?';

    if (buyer === 'Unknown Buyer') {
      buyerCondition = "(po.buyer IS NULL OR po.buyer = '' OR po.buyer = 'Unknown Buyer')";
    } else {
      params.push(buyer);
    }

    if (start_date && end_date) {
      dateFilter = 'AND po.po_date BETWEEN ? AND ?';
      params.push(start_date, end_date);
    }

    const [rows] = await pool.query(`
      SELECT
        po.id,
        po.po_number,
        po.po_date,
        po.po_delivery_date,
        po.status,
        COALESCE(SUM(pi.quantity * pi.price), 0) AS total_value,
        COALESCE(SUM(pi.quantity), 0) AS total_quantity
      FROM purchase_orders po
      LEFT JOIN po_items pi ON pi.po_id = po.id
      WHERE po.company_id = ? AND ${buyerCondition} ${dateFilter}
      GROUP BY po.id
      ORDER BY po.po_date DESC
    `, params);

    const pos = rows.map((r) => ({
      id: r.id,
      poNumber: r.po_number,
      poDate: r.po_date,
      deliveryDate: r.po_delivery_date,
      status: r.status,
      totalValue: Number(r.total_value || 0),
      totalQuantity: Number(r.total_quantity || 0),
    }));

    res.json({ success: true, buyer, pos });
  } catch (error) {
    console.error('Error fetching buyer POs:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch purchase orders for buyer.' });
  }
});


router.get('/summary/dates/:date/pos', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const targetDate = req.params.date;
  try {
    const [rows] = await pool.query(`
      SELECT
        po.id,
        po.po_number,
        po.buyer,
        po.po_date,
        po.po_delivery_date,
        po.status,
        po.sync_status,
        po.last_synced_at,
        COALESCE(SUM(pi.quantity * pi.price), 0) AS total_value,
        COALESCE(SUM(pi.quantity), 0) AS total_quantity
      FROM purchase_orders po
      LEFT JOIN po_items pi ON pi.po_id = po.id
      WHERE po.company_id = ? AND DATE(po.po_date) = ?
      GROUP BY po.id
      ORDER BY po.id DESC
    `, [company_id, targetDate]);

    const pos = rows.map((r) => ({
      id: r.id,
      poNumber: r.po_number,
      buyer: r.buyer,
      poDate: r.po_date,
      deliveryDate: r.po_delivery_date,
      status: r.status,
      sync_status: r.sync_status,
      last_synced_at: r.last_synced_at,
      totalValue: Number(r.total_value || 0),
      totalQuantity: Number(r.total_quantity || 0),
    }));

    res.json({ success: true, pos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------
// LEVEL 3 (item view) reuses your EXISTING route:
//   GET /api/purchase-orders/:id
// It already returns { purchase_order, items, alreadyShipped } — the
// frontend will read po_delivery_date + status from purchase_order, and
// item_no / item_name / item_picture / inspection_status from items.
// No backend change needed for Level 3.
// ---------------------------------------------------------------------

// GET /api/purchase-orders/:id -> orders/edit_po.php (fetch PO + items)
router.get('/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const [poRows] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [req.params.id, company_id]);

  if (!poRows[0]) return res.status(404).json({ success: false, message: 'Purchase order not found' });
  const [items] = await pool.query('SELECT * FROM po_items WHERE po_id = ?', [req.params.id]);

  // Get PO level already shipped
  const [poShipmentRows] = await pool.query('SELECT SUM(shipped_quantity) as total_shipped FROM po_shipments WHERE po_id = ?', [req.params.id]);
  const alreadyShipped = poShipmentRows[0]?.total_shipped || 0;

  // Get item level already shipped
  const [itemShipmentRows] = await pool.query(`
    SELECT si.po_item_id, SUM(si.quantity) as total_shipped
    FROM shipment_items si
    JOIN po_shipments ps ON ps.id = si.shipment_id
    WHERE ps.po_id = ?
    GROUP BY si.po_item_id
  `, [req.params.id]);

  const shippedByItem = {};
  itemShipmentRows.forEach(row => {
    shippedByItem[row.po_item_id] = row.total_shipped;
  });

  const itemsWithShipped = items.map(item => ({
    ...item,
    already_shipped: shippedByItem[item.id] || 0
  }));

  res.json({ success: true, purchase_order: poRows[0], items: itemsWithShipped, alreadyShipped });
});



// POST /api/purchase-orders -> orders/create_purchase_order.php
router.post('/', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { po_number, po_date, buyer, buyer_address, factory, factory_email, factory_address, po_delivery_date, special_comments, terms, items } = req.body;



  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const safe_po_date = po_date ? po_date : null;
    const safe_delivery_date = po_delivery_date ? po_delivery_date : null;

    const [result] = await conn.query(
      `INSERT INTO purchase_orders
        (company_id, po_number, po_date, buyer, buyer_address, factory, factory_email, factory_address, po_delivery_date, special_comments, terms, status, revision_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0)`,
      [company_id, po_number, safe_po_date, buyer, buyer_address, factory, factory_email, factory_address, safe_delivery_date, special_comments, terms]
    );

    const po_id = result.insertId;

    if (Array.isArray(items)) {
      for (const it of items) {
        await conn.query(
          `INSERT INTO po_items (po_id, serial_number, item_no, item_name, description, item_picture, quantity, price, currency, size, eft, finish, special_comments)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            po_id,
            it.serial_number || null,
            it.item_no || null,
            it.item_name || null,
            it.description || null,
            it.item_picture || null,
            it.quantity || 0,
            it.price || 0,
            it.currency || 'rs',
            it.size || null,
            it.eft || null,
            it.finish || null,
            it.special_comments || null
          ]
        );
      }
    }

    if (po_date && po_delivery_date) {
      const [allStages] = await conn.query(
        'SELECT * FROM production_stages WHERE company_id = ? ORDER BY order_index ASC',
        [company_id]
      );
      const [workingDays] = await conn.query('SELECT * FROM working_days WHERE company_id = ?', [company_id]);
      const [holidays] = await conn.query('SELECT * FROM holiday_calendars WHERE company_id = ?', [company_id]);

      if (allStages.length > 0) {
        // Handle case where is_enabled might be undefined or 0/1 depending on DB schema
        const safeStages = allStages.map(s => ({ ...s, is_enabled: s.is_enabled !== undefined ? s.is_enabled : 1 }));
        const dates = distributeDates(po_date, po_delivery_date, safeStages, workingDays, holidays);
        for (let i = 0; i < allStages.length; i++) {
          await conn.query(
            'INSERT INTO po_workflow_schedules (po_id, stage_id, scheduled_start_date, scheduled_end_date) VALUES (?, ?, ?, ?)',
            [po_id, allStages[i].id, dates[i]?.start || null, dates[i]?.end || null]
          );
        }
      }
    }

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'create_po', description: `PO ${po_number} created` });
    res.json({ success: true, message: 'Purchase order created successfully', po_id });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ success: false, message: 'Error creating purchase order: ' + err.message });
  } finally {
    conn.release();
  }
});

router.post('/po/:po_id/shipments', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.po_id;
  const { shipped_quantity, shipment_date, delivery_date, vessel_name, container_no, bl_no, notes, items } = req.body;

  if (!shipped_quantity || !shipment_date || !delivery_date) {
    return res.status(400).json({ success: false, message: 'Shipped quantity, shipment date, and delivery date are required' });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO po_shipments (po_id, shipped_quantity, shipment_date, delivery_date, vessel_name, container_no, bl_no, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [po_id, shipped_quantity, shipment_date, delivery_date, vessel_name, container_no, bl_no, notes, req.user.user_id]
    );
    const shipment_id = result.insertId;

    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        // Only insert if quantity > 0
        if (Number(item.shipQuantity) > 0) {
          await conn.query(
            `INSERT INTO shipment_items (shipment_id, po_item_id, quantity, inspection_status) VALUES (?, ?, ?, ?)`,
            [shipment_id, item.id, item.shipQuantity, item.inspectionStatus || 'Pending']
          );
        }
      }
    }

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'create_shipment', description: `Shipment created for PO ${po_id}` });
    res.json({ success: true, message: 'Shipment created successfully', shipment_id });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ success: false, message: 'Error creating shipment: ' + err.message });
  } finally {
    conn.release();
  }
});




// get shipment one id data

// / 1. GET /api/purchase-orders/shipments/all
//    Global list of all shipments across all POs (for the dashboard table)
// ---------------------------------------------------------------------

// router.get('/shipments/all', verifyToken, async (req, res) => {
//   const company_id = req.user.company_id;

//   try {
//     const [rows] = await pool.query(`
//       SELECT
//         s.id,
//         po.po_number,
//         po.factory,
//         s.shipment_date,
//         s.delivery_date,
//         s.shipped_quantity,
//         s.vessel_name,
//         s.container_no,
//         s.bl_no
//       FROM po_shipments s
//       JOIN purchase_orders po ON po.id = s.po_id
//       WHERE po.company_id = ?
//       ORDER BY s.shipment_date DESC
//     `, [company_id]);

//     const shipments = rows.map((row) => ({
//       id: row.id,
//       poNumber: row.po_number,
//       factory: row.factory,
//       shipmentDate: row.shipment_date,
//       deliveryDate: row.delivery_date,
//       shippedQty: Number(row.shipped_quantity || 0),
//       vesselName: row.vessel_name,
//       containerNo: row.container_no,
//       blNo: row.bl_no,
//       status: row.status || 'Pending', // remove fallback once status column is confirmed
//     }));

//     res.json({ success: true, shipments });
//   } catch (error) {
//     console.error('Error fetching all shipments:', error.message);
//     res.status(500).json({ success: false, message: 'Failed to fetch shipments.' });
//   }
// });


router.get('/shipments/all', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;

  try {
    const [rows] = await pool.query(`
      SELECT
        po.id AS po_id,
        po.po_number,
        po.factory,

        -- Total ordered qty from po_items
        (
          SELECT COALESCE(SUM(quantity), 0)
          FROM po_items
          WHERE po_id = po.id
        ) AS total_ordered_qty,

        -- Total shipped qty from po_shipments
        COALESCE(SUM(s.shipped_quantity), 0) AS total_shipped_qty,

        -- Number of shipments
        COUNT(s.id) AS shipment_count,

        -- Latest shipment date
        MAX(s.shipment_date) AS latest_shipment_date,

        -- Latest status (based on most recent shipment)
        (
          SELECT status FROM po_shipments
          WHERE po_id = po.id
          ORDER BY shipment_date DESC, id DESC
          LIMIT 1
        ) AS latest_status

      FROM purchase_orders po
      LEFT JOIN po_shipments s ON s.po_id = po.id
      WHERE po.company_id = ?
      GROUP BY po.id, po.po_number, po.factory
      HAVING shipment_count > 0
      ORDER BY latest_shipment_date DESC
    `, [company_id]);

    const shipments = rows.map((row) => ({
      poId: row.po_id,
      poNumber: row.po_number,
      factory: row.factory,
      totalOrderedQty: Number(row.total_ordered_qty || 0),
      totalShippedQty: Number(row.total_shipped_qty || 0),
      shipmentCount: Number(row.shipment_count || 0),
      latestShipmentDate: row.latest_shipment_date,
      status: row.latest_status || 'Pending',
    }));

    res.json({ success: true, shipments });
  } catch (error) {
    console.error('Error fetching all shipments:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch shipments.' });
  }
});

// ---------------------------------------------------------------------
// 1.5 GET /api/purchase-orders/shipments/po/:poId

router.get('/shipments/po/:poId', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { poId } = req.params;

  try {
    const [poRows] = await pool.query(
      'SELECT po_number, factory FROM purchase_orders WHERE id = ? AND company_id = ?',
      [poId, company_id]
    );

    if (!poRows[0]) {
      return res.status(404).json({ success: false, message: 'PO not found.' });
    }

    const po = {
      poNumber: poRows[0].po_number,
      factory: poRows[0].factory,
    };

    const [history] = await pool.query(`
      SELECT
        s.id AS shipmentId,
        s.shipment_date AS shipmentDate,
        s.delivery_date AS deliveryDate,
        s.shipped_quantity AS shippedQty,
        s.vessel_name AS vesselName,
        s.container_no AS containerNo,
        s.bl_no AS blNo,
        s.status,
        s.shipment_etd AS shipmentEtd,
        s.destination_eta AS destinationEta,
        s.revision_count AS revisionCount,
        s.created_at,
        CONCAT(u.first_name, ' ', u.last_name) AS created_by_name
      FROM po_shipments s
      LEFT JOIN users u ON s.created_by = u.user_id
      WHERE s.po_id = ?
      ORDER BY s.created_at DESC, s.id DESC
    `, [poId]);

    const [itemsRows] = await pool.query(`
      SELECT
        pi.id,
        pi.item_name AS itemCode,
        pi.description AS name,
        pi.quantity AS orderedQty,
        pi.discrepancy_acknowledged_by,
        pi.discrepancy_acknowledged_at,
        (SELECT COALESCE(SUM(quantity), 0) FROM shipment_items WHERE po_item_id = pi.id) AS totalShippedQty,
        pi.ppt_backup_path
      FROM po_items pi
      WHERE pi.po_id = ?
    `, [poId]);

    const items = itemsRows.map(row => ({
      id: row.id,
      itemCode: row.itemCode,
      name: row.name,
      orderedQty: Number(row.orderedQty || 0),
      totalShippedQty: Number(row.totalShippedQty || 0),
      discrepancyAcknowledgedBy: row.discrepancy_acknowledged_by,
      discrepancyAcknowledgedAt: row.discrepancy_acknowledged_at,
      inspectionPptUrl: row.ppt_backup_path
        ? `${process.env.APP_BASE_URL || 'http://localhost:5000'}${row.ppt_backup_path}`
        : null
    }));

    // Attach items to each shipment in history
    for (const sh of history) {
      const [shItems] = await pool.query(`
        SELECT
          si.id,
          si.po_item_id,
          si.quantity,
          si.hsn_code,
          si.item_weight,
          si.cft,
          si.price,
          si.product_size,
          si.ip,
          si.mp,
          si.gift_box,
          pi.item_name AS itemCode,
          pi.description AS name,
          pi.quantity AS orderedQty
        FROM shipment_items si
        JOIN po_items pi ON si.po_item_id = pi.id
        WHERE si.shipment_id = ?
      `, [sh.shipmentId]);
      sh.items = shItems;
    }

    res.json({ success: true, po, history, items });
  } catch (error) {
    console.error('Error fetching PO shipments:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch PO shipments.' });
  }
});

// ---------------------------------------------------------------------
// 2. GET /api/purchase-orders/shipments/:shipmentId

router.get('/shipments/:shipmentId', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { shipmentId } = req.params;

  try {
    const [shipmentRows] = await pool.query(`
      SELECT
        s.id,
        s.po_id,
        po.po_number,
        po.factory,
        s.shipment_date,
        s.delivery_date,
        s.shipped_quantity,
        s.vessel_name,
        s.container_no,
        s.bl_no,
        s.notes
      FROM po_shipments s
      JOIN purchase_orders po ON po.id = s.po_id
      WHERE s.id = ? AND po.company_id = ?
    `, [shipmentId, company_id]);

    if (!shipmentRows[0]) {
      return res.status(404).json({ success: false, message: 'Shipment not found.' });
    }

    const row = shipmentRows[0];
    const shipment = {
      id: row.id,
      poNumber: row.po_number,
      factory: row.factory,
      shipmentDate: row.shipment_date,
      deliveryDate: row.delivery_date,
      shippedQty: Number(row.shipped_quantity || 0),
      vesselName: row.vessel_name,
      containerNo: row.container_no,
      blNo: row.bl_no,
      status: row.status || 'Pending',
      notes: row.notes,
    };

    // Items shipped in THIS specific shipment, joined with po_items
    // for name/code/inspection info.
    const [itemRows] = await pool.query(`
      SELECT
        si.id,
        si.quantity AS shipped_quantity,
        pi.item_name,
        pi.description,
        pi.inspection_status,
        pi.ppt_backup_path
      FROM shipment_items si
      JOIN po_items pi ON pi.id = si.po_item_id
      WHERE si.shipment_id = ?
    `, [shipmentId]);

    const items = itemRows.map((item) => ({
      id: item.id,
      itemCode: item.item_name,
      name: item.description,
      qty: Number(item.shipped_quantity || 0),
      unit: 'pcs',
      inspectionStatus: item.inspection_status || 'pending',
      inspectionPptUrl: item.ppt_backup_path
        ? `${process.env.APP_BASE_URL || 'http://localhost:5000'}${item.ppt_backup_path}`
        : null,
    }));

    res.json({ success: true, shipment, items });
  } catch (error) {
    console.error('Error fetching shipment detail:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch shipment details.' });
  }
});

// ---------------------------------------------------------------------
// 3. GET /api/purchase-orders/shipments/:shipmentId/history

router.get('/shipments/:shipmentId/history', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { shipmentId } = req.params;

  try {
    // Confirm shipment belongs to this company + get its po_id
    const [shipmentRows] = await pool.query(`
      SELECT s.po_id
      FROM po_shipments s
      JOIN purchase_orders po ON po.id = s.po_id
      WHERE s.id = ? AND po.company_id = ?
    `, [shipmentId, company_id]);

    if (!shipmentRows[0]) {
      return res.status(404).json({ success: false, message: 'Shipment not found.' });
    }

    const poId = shipmentRows[0].po_id;

    // PO-level timeline (includes SHIPMENT_ADDED etc.)
    const [timelineRows] = await pool.query(`
      SELECT stage, message, created_at
      FROM po_timeline
      WHERE po_id = ?
      ORDER BY created_at ASC
    `, [poId]);

    // User activity logs — adjust this to however activity_logs
    // actually references a PO/shipment in your schema.
    const [activityRows] = await pool.query(`
      SELECT
        al.action,
        al.created_at,
        u.name AS user_name
      FROM activity_logs al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE JSON_EXTRACT(al.details, '$.po_id') = ?
         OR JSON_EXTRACT(al.details, '$.shipment_id') = ?
      ORDER BY al.created_at ASC
    `, [poId, shipmentId]);

    const timelineEvents = timelineRows.map((t) => ({
      message: t.message || t.stage,
      userName: null,
      timestamp: t.created_at,
    }));

    const activityEvents = activityRows.map((a) => ({
      message: a.action,
      userName: a.user_name,
      timestamp: a.created_at,
    }));

    const history = [...timelineEvents, ...activityEvents].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    res.json({ success: true, history });
  } catch (error) {
    console.error('Error fetching shipment history:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch shipment history.' });
  }
});


// PUT /api/purchase-orders/:id -> orders/edit_po.php
router.put('/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  const userRole = req.user.role;
  const { po_number, po_date, buyer, buyer_address, factory, factory_email, factory_address, po_delivery_date, special_comments, terms, status, items } = req.body;

  const conn = await pool.getConnection();
  try {
    // ── Revision limit check: non-admin users blocked after 3 edits ──
    if (userRole !== 'admin' && userRole !== 'superadmin') {
      const [[poCheck]] = await conn.query(
        'SELECT revision_no FROM purchase_orders WHERE id = ? AND company_id = ?',
        [po_id, company_id]
      );
      if (poCheck && (poCheck.revision_no || 0) >= 3) {
        conn.release();
        return res.status(403).json({
          success: false,
          message: 'Revision limit reached (3/3). Please contact your admin to make further changes.'
        });
      }
    }

    await conn.beginTransaction();
    const safe_po_date = po_date ? po_date : null;
    const safe_delivery_date = po_delivery_date ? po_delivery_date : null;

    let anyChange = false;

    const [updateResult] = await conn.query(
      `UPDATE purchase_orders
       SET po_number=?, po_date=?, buyer=?, buyer_address=?, factory=?, factory_email=?, factory_address=?, po_delivery_date=?, special_comments=?, terms=?, status=?, updated_at=NOW()
       WHERE id=? AND company_id=?`,
      [po_number, safe_po_date, buyer, buyer_address, factory, factory_email, factory_address, safe_delivery_date, special_comments, terms, status, po_id, company_id]
    );
    if (updateResult.changedRows > 0) anyChange = true;

    // Handle items
    if (Array.isArray(items)) {
      const incomingItemIds = items.filter(it => it.id).map(it => it.id);
      if (incomingItemIds.length > 0) {
        const [delRes] = await conn.query('DELETE FROM po_items WHERE po_id = ? AND id NOT IN (?)', [po_id, incomingItemIds]);
        if (delRes.affectedRows > 0) anyChange = true;
      } else {
        const [delRes] = await conn.query('DELETE FROM po_items WHERE po_id = ?', [po_id]);
        if (delRes.affectedRows > 0) anyChange = true;
      }

      for (const it of items) {
        if (it.id) {
          // Update existing item
          const [updateItemRes] = await conn.query(
            `UPDATE po_items SET serial_number=?, item_no=?, item_name=?, description=?, item_picture=?, quantity=?, price=?, currency=?, size=?, eft=?, finish=?, special_comments=?
             WHERE id=? AND po_id=?`,
            [
              it.serial_number || null,
              it.item_no || null,
              it.item_name || null,
              it.description || null,
              it.item_picture || null,
              it.quantity || 0,
              it.price || 0,
              it.currency || '$',
              it.size || null,
              it.eft || null,
              it.finish || null,
              it.special_comments || null,
              it.id,
              po_id
            ]
          );
          if (updateItemRes.changedRows > 0) anyChange = true;
        } else {
          // Insert new item
          const [insertRes] = await conn.query(
            `INSERT INTO po_items (po_id, serial_number, item_no, item_name, description, item_picture, quantity, price, currency, size, eft, finish, special_comments)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              po_id,
              it.serial_number || null,
              it.item_no || null,
              it.item_name || null,
              it.description || null,
              it.item_picture || null,
              it.quantity || 0,
              it.price || 0,
              it.currency || '$',
              it.size || null,
              it.eft || null,
              it.finish || null,
              it.special_comments || null
            ]
          );
          if (insertRes.affectedRows > 0) anyChange = true;
        }
      }
    } else {
      const [delRes2] = await conn.query('DELETE FROM po_items WHERE po_id = ?', [po_id]);
      if (delRes2.affectedRows > 0) anyChange = true;
    }

    if (anyChange) {
      await conn.query(
        `UPDATE purchase_orders 
         SET revision_no = LEAST(IFNULL(revision_no, 0) + 1, 3) 
         WHERE id=? AND company_id=?`,
        [po_id, company_id]
      );
    }

    // Recalculate workflow schedules if dates exist
    if (safe_po_date && safe_delivery_date) {
      const [allStages] = await conn.query('SELECT * FROM production_stages WHERE company_id = ? ORDER BY order_index ASC', [company_id]);
      const [workingDays] = await conn.query('SELECT * FROM working_days WHERE company_id = ?', [company_id]);
      const [holidays] = await conn.query('SELECT * FROM holiday_calendars WHERE company_id = ?', [company_id]);

      if (allStages.length > 0) {
        const safeStages = allStages.map(s => ({ ...s, is_enabled: s.is_enabled !== undefined ? s.is_enabled : 1 }));
        const dates = distributeDates(safe_po_date, safe_delivery_date, safeStages, workingDays, holidays);

        for (let i = 0; i < allStages.length; i++) {
          if (dates[i]) {
            await conn.query(
              `UPDATE po_workflow_schedules 
               SET scheduled_start_date=?, scheduled_end_date=? 
               WHERE po_id=? AND stage_id=?`,
              [dates[i].start || null, dates[i].end || null, po_id, allStages[i].id]
            );
          }
        }
      }
    }

    // Check if it was previously synced
    const [[poSyncData]] = await conn.query('SELECT sync_status FROM purchase_orders WHERE id = ?', [po_id]);

    await conn.commit();
    res.json({ success: true, message: 'Purchase order updated successfully' });

    // Fire and forget background sync if it was already synced
    if (poSyncData && poSyncData.sync_status === 'Synced') {
      const tempConn = await pool.getConnection();
      syncToInspectAppHelper(po_id, company_id, tempConn, req)
        .catch(err => console.error('Auto-sync failed:', err))
        .finally(() => tempConn.release());
    }

  } catch (err) {
    await conn.rollback();
    res.status(400).json({ success: false, message: 'Error updating PO: ' + err.message });
  } finally {
    conn.release();
  }
});

// PATCH /api/purchase-orders/:id/status
router.patch('/:id/status', verifyToken, async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE purchase_orders SET status = ?, updated_at = NOW() WHERE id = ? AND company_id = ?', [status, req.params.id, req.user.company_id]);
  res.json({ success: true, message: 'Status updated' });
});

// POST /api/purchase-orders/:id/request-delete-otp
router.post('/:id/request-delete-otp', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const user_id = req.user.user_id;
  const po_id = req.params.id;

  try {
    // 1. Get PO details to confirm it exists
    const [poRows] = await pool.query('SELECT po_number FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (poRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Purchase order not found' });
    }

    // 2. Get user email
    const [userRows] = await pool.query('SELECT email FROM users WHERE user_id = ?', [user_id]);
    if (userRows.length === 0 || !userRows[0].email) {
      return res.status(400).json({ success: false, message: 'Admin email not found' });
    }

    // 3. Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60000); // 10 minutes from now

    // 4. Save to db
    await pool.query(
      `INSERT INTO po_deletion_otps (company_id, user_id, po_id, otp_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [company_id, user_id, po_id, otpHash, expiresAt]
    );

    // 5. Send Email
    const html = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Delete Purchase Order Request</h2>
        <p>You requested to delete Purchase Order <strong>${poRows[0].po_number}</strong>.</p>
        <p>Your OTP for confirmation is: <strong style="font-size: 24px; color: #d9534f;">${otp}</strong></p>
        <p>This OTP will expire in 10 minutes. If you did not request this, please ignore this email.</p>
      </div>
    `;
    await sendEmail({
      companyId: company_id,
      to: userRows[0].email,
      subject: `OTP for Deleting PO ${poRows[0].po_number}`,
      html
    });

    res.json({ success: true, message: 'OTP sent to registered email' });
  } catch (err) {
    console.error('Error requesting OTP:', err);
    res.status(500).json({ success: false, message: 'Failed to generate OTP' });
  }
});

// DELETE /api/purchase-orders/:id
router.delete('/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [poRows] = await conn.query('SELECT po_number, factory FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (poRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Purchase order not found' });
    }

    const { otp } = req.body;
    if (!otp) {
      return res.status(400).json({ success: false, message: 'OTP is required for deletion' });
    }

    // Verify OTP
    const [otpRows] = await conn.query(
      'SELECT id, otp_hash, attempts, expires_at FROM po_deletion_otps WHERE user_id = ? AND po_id = ? ORDER BY created_at DESC LIMIT 1',
      [req.user.user_id, po_id]
    );

    if (otpRows.length === 0) {
      return res.status(400).json({ success: false, message: 'No OTP request found' });
    }

    const otpRecord = otpRows[0];
    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(400).json({ success: false, message: 'OTP has expired' });
    }

    if (otpRecord.attempts >= 3) {
      return res.status(400).json({ success: false, message: 'Maximum attempts reached. Please request a new OTP.' });
    }

    const isMatch = await bcrypt.compare(otp, otpRecord.otp_hash);
    if (!isMatch) {
      await conn.query('UPDATE po_deletion_otps SET attempts = attempts + 1 WHERE id = ?', [otpRecord.id]);
      return res.status(400).json({ success: false, message: 'Incorrect OTP' });
    }

    const po_number = poRows[0].po_number;
    const factory = poRows[0].factory || 'Unknown Factory';

    await conn.query('DELETE FROM po_items WHERE po_id = ?', [po_id]);
    await conn.query('DELETE FROM po_workflow_schedules WHERE po_id = ?', [po_id]);
    await conn.query('DELETE FROM sync_logs WHERE erp_po_id = ?', [po_id]);
    await conn.query('DELETE FROM purchase_orders WHERE id = ?', [po_id]);
    await conn.query('DELETE FROM po_deletion_otps WHERE po_id = ?', [po_id]);

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'delete_po', description: `PO ${po_number} (Factory: ${factory}) deleted permanently.` });
    res.json({ success: true, message: 'Purchase order deleted successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Error deleting PO: ' + err.message });
  } finally {
    conn.release();
  }
});

const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');

// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     cb(null, 'uploads/items/');
//   },
//   filename: function (req, file, cb) {
//     const ext = path.extname(file.originalname);
//     const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
//     cb(null, file.fieldname + '-' + uniqueSuffix + ext);
//   }
// });

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'po-items',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    public_id: (req, file) => `image-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  },
});

const upload = multer({ storage: storage });
const os = require('os');
const excelUpload = multer({ dest: os.tmpdir() });

// POST /api/purchase-orders/upload-image
// router.post('/upload-image', verifyToken, upload.single('image'), (req, res) => {
//   if (!req.file) {
//     return res.status(400).json({ success: false, message: 'No file uploaded' });
//   }
//   const imageUrl = `/uploads/items/${req.file.filename}`;
//   res.json({ success: true, url: imageUrl });
// });

router.post('/upload-image', verifyToken, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }
  const imageUrl = req.file.path; // Cloudinary returns full URL in req.file.path
  res.json({ success: true, url: imageUrl });
});

// POST /api/purchase-orders/shipments/validate-import
router.post('/shipments/validate-import', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { mappedData } = req.body;

  if (!mappedData || !Array.isArray(mappedData)) {
    return res.status(400).json({ success: false, message: 'Invalid data' });
  }

  const conn = await pool.getConnection();
  try {
    const results = [];
    const posCache = {};

    for (let i = 0; i < mappedData.length; i++) {
      const row = mappedData[i];
      const poNumber = (row['po_number'] || '').toString().trim();
      const itemNumber = (row['item_no'] || '').toString().trim();
      const qtyShipped = Number(row['qty_shipped']) || 0;

      const rowResult = { rowIndex: i, status: 'valid', errors: [], mismatches: [], warnings: [], rowData: row };

      if (!poNumber) {
        rowResult.status = 'error';
        rowResult.errors.push('PO Number is missing');
        results.push(rowResult);
        continue;
      }
      if (!itemNumber) {
        rowResult.status = 'error';
        rowResult.errors.push('Item Number is missing');
        results.push(rowResult);
        continue;
      }

      if (!posCache[poNumber]) {
        const [poRows] = await conn.query('SELECT id FROM purchase_orders WHERE po_number = ? AND company_id = ?', [poNumber, company_id]);
        if (poRows.length === 0) {
          posCache[poNumber] = null;
        } else {
          const po_id = poRows[0].id;
          const [items] = await conn.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);
          const [shipments] = await conn.query('SELECT po_item_id, SUM(quantity) as total_shipped FROM shipment_items si JOIN po_shipments ps ON si.shipment_id = ps.id WHERE ps.po_id = ? GROUP BY po_item_id', [po_id]);
          posCache[poNumber] = { id: po_id, items, shipments };
        }
      }

      const cachedPo = posCache[poNumber];
      if (!cachedPo) {
        rowResult.status = 'error';
        rowResult.errors.push(`PO '${poNumber}' not found`);
        results.push(rowResult);
        continue;
      }

      const poItem = cachedPo.items.find(it =>
        (it.item_no || '').toString().trim().toLowerCase() === itemNumber.toLowerCase() ||
        (it.item_name || '').toString().trim().toLowerCase() === itemNumber.toLowerCase()
      );
      if (!poItem) {
        rowResult.status = 'error';
        rowResult.errors.push(`Item '${itemNumber}' does not belong to PO '${poNumber}'`);
        results.push(rowResult);
        continue;
      }

      const shipmentRecord = cachedPo.shipments.find(s => s.po_item_id === poItem.id);
      const previouslyShipped = shipmentRecord ? Number(shipmentRecord.total_shipped) : 0;
      const orderedQty = Number(poItem.quantity) || 0;
      const pendingQty = orderedQty - previouslyShipped;

      if (qtyShipped > pendingQty) {
        rowResult.status = 'error';
        rowResult.errors.push(`Qty Shipped (${qtyShipped}) > Pending (${pendingQty})`);
      }

      const checkMismatch = (excelVal, poVal, fieldName) => {
        if (excelVal === undefined || excelVal === null || excelVal === '') return;
        if (poVal === undefined || poVal === null || poVal === '') return;
        const e = excelVal.toString().trim().toLowerCase();
        const p = poVal.toString().trim().toLowerCase();
        if (fieldName === 'Price') {
          if (Math.abs(Number(excelVal) - Number(poVal)) > 0.01) {
            rowResult.mismatches.push({ field: fieldName, poValue: poVal, excelValue: excelVal });
          }
        } else if (e !== p) {
          rowResult.mismatches.push({ field: fieldName, poValue: poVal, excelValue: excelVal });
        }
      };

      checkMismatch(row['price'], poItem.price, 'Price');
      checkMismatch(row['product_size'], poItem.size, 'Size');
      checkMismatch(row['length'], poItem.length, 'Length');
      checkMismatch(row['width'], poItem.width, 'Width');
      checkMismatch(row['height'], poItem.height, 'Height');
      checkMismatch(row['item_weight'], poItem.weight || poItem.net_weight, 'Weight');
      checkMismatch(row['cft'], poItem.cft, 'CFT');
      checkMismatch(row['ip'], poItem.ip, 'IP');
      checkMismatch(row['mp'], poItem.mp, 'MP');
      checkMismatch(row['gift_box'], poItem.gift_box, 'Gift Box');

      if (!row['container_no']) rowResult.warnings.push('Container No is missing');
      if (!row['shipment_etd']) rowResult.warnings.push('ETD is missing');
      if (!row['destination_eta']) rowResult.warnings.push('Destination ETA is missing');

      rowResult.po_id = cachedPo.id;
      rowResult.po_item_id = poItem.id;
      results.push(rowResult);
    }

    res.json({ success: true, validation: results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/purchase-orders/shipments/import-confirm
router.post('/shipments/import-confirm', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { validRows } = req.body;

  if (!validRows || !Array.isArray(validRows) || validRows.length === 0) {
    return res.status(400).json({ success: false, message: 'No valid data provided' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Group by PO Number
    const poGroups = {};
    validRows.forEach(row => {
      const poId = row.po_id;
      if (!poGroups[poId]) {
        poGroups[poId] = {
          po_id: poId,
          items: []
        };
      }
      poGroups[poId].items.push(row);
    });

    for (const poId in poGroups) {
      const group = poGroups[poId];
      // Get current date for shipment date if not specified
      const shipmentDate = new Date().toISOString().split('T')[0];

      const [shRes] = await conn.query(
        `INSERT INTO po_shipments (po_id, shipped_quantity, shipment_date, created_by) VALUES (?, ?, ?, ?)`,
        [group.po_id, 0, shipmentDate, req.user.user_id]
      );
      const shipmentId = shRes.insertId;
      let totalQty = 0;

      for (const itemRow of group.items) {
        const qty = Number(itemRow.rowData.qty_shipped) || 0;
        totalQty += qty;
        await conn.query(
          `INSERT INTO shipment_items 
            (shipment_id, po_item_id, quantity, hsn_code, item_weight, cft, price, product_size, length, width, height, ip, mp, gift_box, inspection_status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            shipmentId,
            itemRow.po_item_id,
            qty,
            itemRow.rowData.hsn_code || '',
            itemRow.rowData.item_weight || null,
            itemRow.rowData.cft || null,
            itemRow.rowData.price || null,
            itemRow.rowData.product_size || '',
            itemRow.rowData.length || '',
            itemRow.rowData.width || '',
            itemRow.rowData.height || '',
            itemRow.rowData.ip || '',
            itemRow.rowData.mp || '',
            itemRow.rowData.gift_box || '',
            'Pending'
          ]
        );
      }

      // Update total qty
      await conn.query('UPDATE po_shipments SET shipped_quantity = ? WHERE id = ?', [totalQty, shipmentId]);
    }

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'import_shipments', description: `Imported shipments from Excel.` });
    res.json({ success: true, message: 'Shipments imported successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Error importing shipments: ' + err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/purchase-orders/shipments/:id
router.put('/shipments/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const shipment_id = req.params.id;
  const { container_no, shipment_etd, destination_eta, items } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT ps.*, po.company_id 
       FROM po_shipments ps 
       JOIN purchase_orders po ON ps.po_id = po.id 
       WHERE ps.id = ?`,
      [shipment_id]
    );

    if (existing.length === 0 || existing[0].company_id !== company_id) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Shipment not found' });
    }

    const revCount = existing[0].revision_count || 0;

    // Check if normal user and max revisions reached
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin' && revCount >= 3) {
      await conn.rollback();
      return res.status(403).json({ success: false, message: 'Maximum revisions (3) reached for this shipment. Please contact an admin.' });
    }

    const newRevCount = revCount + 1;

    // Helper to log audit
    const logAudit = async (action, fieldName, oldVal, newVal) => {
      // Don't log if values are the same
      if (oldVal == newVal) return;
      if (oldVal === null && newVal === '') return;
      if (oldVal === '' && newVal === null) return;

      await conn.query(
        `INSERT INTO shipment_audit_logs (shipment_id, user_id, action, field_name, old_value, new_value, revision_no)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [shipment_id, req.user.user_id, action, fieldName, oldVal?.toString(), newVal?.toString(), newRevCount]
      );
    };

    // Update shipment header fields
    await logAudit('update', 'container_no', existing[0].container_no, container_no);
    await logAudit('update', 'shipment_etd', existing[0].shipment_etd, shipment_etd);
    await logAudit('update', 'destination_eta', existing[0].destination_eta, destination_eta);

    await conn.query(
      `UPDATE po_shipments 
       SET container_no = ?, shipment_etd = ?, destination_eta = ?, revision_count = ? 
       WHERE id = ?`,
      [container_no || null, shipment_etd || null, destination_eta || null, newRevCount, shipment_id]
    );

    // Update shipment items
    let newTotalQty = 0;
    if (items && Array.isArray(items)) {
      for (const item of items) {
        // Fetch current shipment item
        const [existingItemRows] = await conn.query('SELECT * FROM shipment_items WHERE id = ? AND shipment_id = ?', [item.id, shipment_id]);
        if (existingItemRows.length === 0) continue;
        const oldItem = existingItemRows[0];
        const newQty = Number(item.quantity) || 0;
        newTotalQty += newQty;

        // Fetch PO Item to get ordered quantity
        const [poItemRows] = await conn.query('SELECT quantity FROM po_items WHERE id = ?', [oldItem.po_item_id]);
        const poOrderedQty = poItemRows.length > 0 ? Number(poItemRows[0].quantity) : 0;

        // Calculate total shipped for this PO item excluding THIS specific shipment
        const [otherShipments] = await conn.query(
          `SELECT SUM(quantity) as other_shipped FROM shipment_items si JOIN po_shipments ps ON si.shipment_id = ps.id 
           WHERE si.po_item_id = ? AND si.shipment_id != ?`,
          [oldItem.po_item_id, shipment_id]
        );
        const otherShipped = Number(otherShipments[0].other_shipped) || 0;

        // Over-shipments are allowed, handled in UI.

        // Log item field changes
        await logAudit('update_item', 'quantity', oldItem.quantity, newQty);
        await logAudit('update_item', 'price', oldItem.price, item.price);
        await logAudit('update_item', 'item_weight', oldItem.item_weight, item.item_weight);
        await logAudit('update_item', 'cft', oldItem.cft, item.cft);
        await logAudit('update_item', 'product_size', oldItem.product_size, item.product_size);
        await logAudit('update_item', 'ip', oldItem.ip, item.ip);
        await logAudit('update_item', 'mp', oldItem.mp, item.mp);
        await logAudit('update_item', 'gift_box', oldItem.gift_box, item.gift_box);
        await logAudit('update_item', 'hsn_code', oldItem.hsn_code, item.hsn_code);

        await conn.query(
          `UPDATE shipment_items 
           SET quantity = ?, price = ?, item_weight = ?, cft = ?, product_size = ?, ip = ?, mp = ?, gift_box = ?, hsn_code = ?
           WHERE id = ?`,
          [newQty, item.price || null, item.item_weight || null, item.cft || null, item.product_size || '', item.ip || '', item.mp || '', item.gift_box || '', item.hsn_code || '', oldItem.id]
        );
      }

      // Update shipment header total qty
      await conn.query('UPDATE po_shipments SET shipped_quantity = ? WHERE id = ?', [newTotalQty, shipment_id]);
    }

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'update_shipment', description: `Updated shipment ${shipment_id} (Rev ${newRevCount})` });
    res.json({ success: true, message: 'Shipment updated successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/purchase-orders/import
router.post('/import', verifyToken, excelUpload.single('file'), async (req, res) => {
  let data, duplicateOption;

  if (req.body.data) {
    try {
      // If it's sent as JSON string in form-data
      const parsed = JSON.parse(req.body.data);
      data = parsed.data || parsed;
      duplicateOption = req.body.duplicateOption || parsed.duplicateOption || 'skip';
    } catch (e) {
      data = req.body.data;
      duplicateOption = req.body.duplicateOption || 'skip';
    }
  } else {
    data = req.body;
  }

  if (req.is('application/json')) {
    data = req.body.data;
    duplicateOption = req.body.duplicateOption || 'skip';
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ success: false, message: 'No valid data provided' });
  }

  const company_id = req.user.company_id;
  const summary = { success: 0, failed: 0, skipped: 0, duplicates: 0, warnings: 0, errors: 0, details: [] };

  // 1. Fetch the last PO number for today
  const dateObj = new Date();
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  let lastNumber = 0;
  try {
    const [rows] = await pool.query(
      "SELECT MAX(po_number) as last_po FROM purchase_orders WHERE po_number LIKE ? AND company_id = ?",
      [`PO-${dateStr}-%`, company_id]
    );
    if (rows[0] && rows[0].last_po) {
      const parts = rows[0].last_po.split('-');
      if (parts.length >= 3) {
        lastNumber = parseInt(parts[2], 10) || 0;
      }
    }
  } catch (err) {
    console.error('Error fetching max PO number for import:', err);
  }

  // 1. Group rows
  const poGroups = {};
  const factoryToNewPo = {};

  data.forEach((row, index) => {
    let po_number = row.po_number;
    if (!po_number) {
      // Group by factory if po_number is missing
      const factoryKey = row.factory ? String(row.factory).trim() : 'UNKNOWN';
      if (!factoryToNewPo[factoryKey]) {
        lastNumber++;
        factoryToNewPo[factoryKey] = `PO-${dateStr}-${String(lastNumber).padStart(3, '0')}`;
      }
      po_number = factoryToNewPo[factoryKey];
    } else {
      po_number = String(po_number).trim();
    }


    if (!poGroups[po_number]) {
      poGroups[po_number] = {
        po_number,
        buyer: row.buyer || '',
        buyer_address: row.buyer_address || '',
        factory: row.factory || '',
        factory_email: row.factory_email || '',
        factory_address: row.factory_address || '',
        po_date: row.po_date || new Date(),
        po_delivery_date: row.delivery_date || row.po_delivery_date || null,
        special_comments: row.special_comments || '',
        status: row.status || 'draft',
        items: []
      };
    }

    // Add item
    const qty = Number(row.quantity) || 0;
    if (qty <= 0) {
      summary.warnings++;
      summary.details.push({ row: index + 1, po_number, item: row.item_number || row.item_no || row.item_name, status: 'warning', reason: 'Quantity is 0 or invalid' });
    }

    poGroups[po_number].items.push({
      _rowIndex: index + 1,
      serial_number: row.serial_number || null,
      item_no: row.item_number || row.item_no || null,
      item_name: row.item_name || row.description || null,
      description: row.description || null,
      item_picture: row.item_picture || null,
      quantity: qty,
      price: Number(row.price) || 0,
      currency: row.currency || 'USD',
      size: row.size || null,
      eft: row.eft || null,
      finish: row.finish || null
    });
  });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 2. Process groups
    for (const po_number in poGroups) {
      const group = poGroups[po_number];

      // Delivery date validation removed

      // Duplicate detection
      const [existingPo] = await conn.query('SELECT id FROM purchase_orders WHERE po_number = ? AND company_id = ?', [po_number, company_id]);

      let po_id = null;
      let isDuplicate = existingPo.length > 0;

      if (isDuplicate) {
        if (duplicateOption === 'skip') {
          summary.skipped += group.items.length;
          summary.duplicates++;
          summary.details.push({ po_number, status: 'skipped', reason: 'PO already exists (Skip Existing)' });
          continue;
        } else if (duplicateOption === 'duplicate') {
          // Generate a new PO number
          group.po_number = `${po_number}-DUP-${Math.floor(Math.random() * 1000)}`;
          summary.duplicates++;
          summary.details.push({ po_number: group.po_number, status: 'warning', reason: 'Duplicate PO found, created as new (Create Duplicate)' });
          // Proceed to insert as new
        } else if (duplicateOption === 'update' || duplicateOption === 'merge') {
          po_id = existingPo[0].id;
          // Update master PO fields
          await conn.query(
            `UPDATE purchase_orders SET buyer=?, buyer_address=?, factory=?, factory_email=?, factory_address=?, po_date=?, po_delivery_date=?, special_comments=? WHERE id=?`,
            [group.buyer, group.buyer_address, group.factory, group.factory_email, group.factory_address, group.po_date, group.po_delivery_date, group.special_comments, po_id]
          );

          if (duplicateOption === 'update') {
            // Replace all items
            await conn.query('DELETE FROM po_items WHERE po_id = ?', [po_id]);
          }
          summary.duplicates++;
          summary.details.push({ po_number, status: 'success', reason: `PO updated (${duplicateOption === 'update' ? 'Update' : 'Merge'} Existing)` });
        }
      }

      if (!po_id) { // Insert new PO
        const [result] = await conn.query(
          `INSERT INTO purchase_orders 
           (company_id, po_number, po_date, buyer, buyer_address, factory, factory_email, factory_address, po_delivery_date, special_comments, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [company_id, group.po_number, group.po_date, group.buyer, group.buyer_address, group.factory, group.factory_email, group.factory_address, group.po_delivery_date, group.special_comments, group.status]
        );
        po_id = result.insertId;
      }

      // Insert Items
      let itemsInserted = 0;
      for (const it of group.items) {
        // Validate image url
        let pic = it.item_picture;
        if (pic && !String(pic).startsWith('http') && !String(pic).startsWith('/')) pic = null;

        await conn.query(
          `INSERT INTO po_items (po_id, serial_number, item_no, item_name, description, item_picture, quantity, price, currency, size, eft, finish, special_comments)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [po_id, it.serial_number, it.item_no, it.item_name, it.description, pic, it.quantity, it.price, it.currency || 'USD', it.size, it.eft, it.finish, it.special_comments || null]
        );
        itemsInserted++;
      }

      if (!isDuplicate || duplicateOption === 'duplicate') {
        summary.success += itemsInserted;
      }

      // Graceful OFC Generation
      if (group.po_date && group.po_delivery_date) {
        try {
          const [allStages] = await conn.query('SELECT * FROM production_stages WHERE company_id = ? ORDER BY order_index ASC', [company_id]);
          const [workingDays] = await conn.query('SELECT * FROM working_days WHERE company_id = ?', [company_id]);
          const [holidays] = await conn.query('SELECT * FROM holiday_calendars WHERE company_id = ?', [company_id]);

          if (allStages.length > 0) {
            // Check if schedules already exist to avoid duplication
            const [existingSchedules] = await conn.query('SELECT id FROM po_workflow_schedules WHERE po_id = ?', [po_id]);
            if (existingSchedules.length === 0 || duplicateOption === 'update') {
              if (duplicateOption === 'update') {
                await conn.query('DELETE FROM po_workflow_schedules WHERE po_id = ?', [po_id]);
              }
              const safeStages = allStages.map(s => ({ ...s, is_enabled: s.is_enabled !== undefined ? s.is_enabled : 1 }));
              const dates = distributeDates(group.po_date, group.po_delivery_date, safeStages, workingDays, holidays);
              for (let i = 0; i < allStages.length; i++) {
                await conn.query(
                  'INSERT INTO po_workflow_schedules (po_id, stage_id, scheduled_start_date, scheduled_end_date) VALUES (?, ?, ?, ?)',
                  [po_id, allStages[i].id, dates[i]?.start || null, dates[i]?.end || null]
                );
              }
            }
          }
        } catch (e) {
          summary.warnings++;
          summary.details.push({ po_number: group.po_number, status: 'warning', reason: 'Failed to generate OFC schedules automatically: ' + e.message });
        }
      }
    }

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'import_pos', description: `Imported POs. Success: ${summary.success}, Skipped: ${summary.skipped}` });
    res.json({ success: true, message: 'Import completed', summary });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Database error during import. All changes rolled back.', error: err.message });
  } finally {
    conn.release();
  }
});



// POST /api/purchase-orders/extract-images
router.post('/extract-images', verifyToken, excelUpload.single('file'), async (req, res) => {
  if (!req.file) {
    console.log('[extract-images] No file uploaded');
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const filePath = req.file.path;
  console.log(`[extract-images] Processing file: ${filePath}`);

  try {
    const workbook = new ExcelJs.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      console.log('[extract-images] No worksheet found');
      return res.json({ success: true, images: {} });
    }

    const embeddedImages = worksheet.getImages(); // [{ imageId, range }]
    console.log(`[extract-images] Found ${embeddedImages.length} embedded images`);

    const uploadPromises = embeddedImages.map((embedded, i) => {
      return new Promise((resolve) => {
        const img = workbook.getImage(embedded.imageId); // { buffer, extension }
        if (!img || !img.buffer) {
          console.log(`[extract-images] Image ${i} has no buffer`);
          resolve(null);
          return;
        }

        // nativeRow is 0-indexed and matches the raw sheet row array on the frontend
        let rowIndex;
        if (embedded.range && embedded.range.tl) {
          rowIndex = Math.round(
            embedded.range.tl.nativeRow !== undefined
              ? embedded.range.tl.nativeRow
              : embedded.range.tl.row
          );
        } else {
          console.log(`[extract-images] Image ${i} has no range.tl data`, embedded.range);
          rowIndex = -1;
        }

        console.log(`[extract-images] Uploading image for row ${rowIndex}...`);

        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: 'po-items', resource_type: 'image' },
          (error, result) => {
            if (error) {
              console.error(`[extract-images] Upload failed for row ${rowIndex}:`, error.message);
              resolve(null); // skip this image, don't fail the whole import
              return;
            }
            console.log(`[extract-images] Upload success for row ${rowIndex}: ${result.secure_url}`);
            resolve({ rowIndex, url: result.secure_url });
          }
        );
        uploadStream.end(img.buffer);
      });
    });

    const results = await Promise.all(uploadPromises);

    const images = {};
    results.forEach((r) => {
      if (r && r.rowIndex >= 0) images[r.rowIndex] = r.url;
    });

    console.log('[extract-images] Final image map:', images);
    res.json({ success: true, images });
  } catch (err) {
    console.error('[extract-images] Error extracting images from Excel:', err);
    res.status(500).json({ success: false, message: 'Failed to extract images: ' + err.message });
  } finally {
    // excelUpload writes the file to disk (dest: 'uploads/') — clean it up
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) console.warn('[extract-images] Failed to delete temp file:', filePath, unlinkErr.message);
    });
  }
});

// 
const { generatePODocx, generatePOXlsx } = require('../utils/documentGenerator');

const PPT_BACKUP_DIR = path.join(__dirname, '..', 'uploads', 'ppt_backups');
if (!fs.existsSync(PPT_BACKUP_DIR)) {
  fs.mkdirSync(PPT_BACKUP_DIR, { recursive: true });
}

// Download a file from a URL into a Buffer (same pattern used for
// item_picture in generatePODocxFromTemplate.js).
function downloadFileBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (fileRes) => {
      if (fileRes.statusCode >= 400) {
        reject(new Error(`Download failed with status ${fileRes.statusCode}`));
        return;
      }
      const chunks = [];
      fileRes.on('data', (chunk) => chunks.push(chunk));
      fileRes.on('end', () => resolve(Buffer.concat(chunks)));
      fileRes.on('error', reject);
    }).on('error', reject);
  });
}

router.get('/:id/inspection-status', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  const inspectAppUrl = process.env.INSPECTAPP_STATUS_API_URL
    || 'http://localhost/InspectAppBackup/git 28 july/api/get_inspection_status.php';
  const inspectAppToken = process.env.INSPECTAPP_API_TOKEN || 'f2c_secret_token_123';

  const conn = await pool.getConnection();
  try {
    // 1. Confirm PO belongs to this company and is actually synced
    const [poRows] = await conn.query(
      'SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?',
      [po_id, company_id]
    );
    if (!poRows[0]) {
      return res.status(404).json({ success: false, message: 'PO not found' });
    }
    const po = poRows[0];

    if (po.sync_status !== 'Synced') {
      // Nothing to check yet — PO hasn't been sent to InspectApp
      return res.json({ success: true, items: [], message: 'PO not yet synced' });
    }

    // 2. Ask InspectApp for the latest status + ppt_url per item
    const response = await fetch(inspectAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${inspectAppToken}`
      },
      body: JSON.stringify({ erp_po_id: po_id })
    });

    const responseText = await response.text();
    let parsed = {};
    try { parsed = JSON.parse(responseText); } catch (e) { parsed = { message: responseText }; }

    if (!response.ok || parsed.status !== 'success') {
      return res.status(400).json({
        success: false,
        message: 'Failed to fetch status from InspectApp: ' + (parsed.message || `HTTP ${response.status}`)
      });
    }

    const remoteItems = parsed.items || [];
    const results = [];

    // 3. For each item: update status, and backup PPT if it's new/changed
    for (const remoteItem of remoteItems) {
      const { erp_item_id, status, ppt_url } = remoteItem;

      // Get current DB state for this item so we know if we already have a backup
      const [[currentItem]] = await conn.query(
        'SELECT id, ppt_source_url, ppt_backup_path FROM po_items WHERE id = ? AND po_id = ?',
        [erp_item_id, po_id]
      );
      if (!currentItem) continue; // item not found under this PO, skip

      let backupPath = currentItem.ppt_backup_path;
      let sourceUrl = currentItem.ppt_source_url;

      // Always download if there's a ppt_url to ensure we have the latest overwritten file
      if (ppt_url) {
        try {
          let fullPptUrl = ppt_url;
          if (ppt_url.startsWith('/')) {
            let fixedPath = ppt_url.replace('/uaAdmin/inspectapp', '/InspectAppBackup/git%2028%20july');
            const baseUrl = new URL(inspectAppUrl).origin;
            fullPptUrl = baseUrl + fixedPath;
          }
          const fileBuffer = await downloadFileBuffer(fullPptUrl);
          const ext = path.extname(new URL(fullPptUrl).pathname) || '.pptx';
          const filename = `item_${erp_item_id}_${Date.now()}${ext}`;
          const filePath = path.join(PPT_BACKUP_DIR, filename);
          fs.writeFileSync(filePath, fileBuffer);

          // New download succeeded — now delete the OLD backup file (if any),
          // since we only keep the latest PPT per item, not a history of them.
          if (currentItem.ppt_backup_path) {
            const oldFilePath = path.join(
              PPT_BACKUP_DIR,
              path.basename(currentItem.ppt_backup_path)
            );
            fs.unlink(oldFilePath, (unlinkErr) => {
              if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                // ENOENT = file already gone, safe to ignore. Anything else, just log it —
                // we don't want a cleanup failure to break the status/backup update itself.
                console.warn(`[PPT Backup] Could not delete old file ${oldFilePath}: ${unlinkErr.message}`);
              } else if (!unlinkErr) {
                console.log(`[PPT Backup] Deleted old backup: ${oldFilePath}`);
              }
            });
          }

          backupPath = `/uploads/ppt_backups/${filename}`; // web-accessible path
          sourceUrl = ppt_url;

          console.log(`[PPT Backup] Saved backup for item ${erp_item_id}: ${backupPath}`);
        } catch (downloadErr) {
          console.warn(`[PPT Backup] Failed to download PPT for item ${erp_item_id}: ${downloadErr.message}`);
          // Keep going — status still gets updated even if the download failed.
          // We deliberately did NOT touch backupPath/sourceUrl above, so the
          // existing (old) backup file stays intact and untouched on disk —
          // we only delete it once a new download has actually succeeded.
          // We'll simply retry the download next time this route is called,
          // since ppt_source_url wasn't updated to match ppt_url.
        }
      }

      // 4. Persist status + backup info
      await conn.query(
        `UPDATE po_items
         SET inspection_status = ?,
             ppt_source_url = ?,
             ppt_backup_path = ?,
             inspection_last_checked_at = NOW()
         WHERE id = ? AND po_id = ?`,
        [status, sourceUrl, backupPath, erp_item_id, po_id]
      );

      results.push({
        erp_item_id,
        status,
        ppt_backup_path: backupPath // frontend should link to THIS, not ppt_url directly
      });
    }

    res.json({ success: true, items: results });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching inspection status: ' + err.message });
  } finally {
    conn.release();
  }
});

// POST /api/purchase-orders/:id/send-shipping-update
router.post('/:id/send-shipping-update', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  const { message, tracking_number } = req.body;

  try {
    const [poRows] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (!poRows[0]) return res.status(404).json({ success: false, message: 'PO not found' });

    const po = poRows[0];
    if (!po.factory_email) {
      return res.status(400).json({ success: false, message: 'Supplier/Factory does not have an email address.' });
    }

    const htmlContent = `
      <h3>Shipping Update for PO #${po.po_number}</h3>
      <p>Hello,</p>
      <p>This is an automated shipping update regarding your Purchase Order.</p>
      <p><strong>Tracking Number:</strong> ${tracking_number || 'N/A'}</p>
      <p><strong>Message:</strong></p>
      <p>${message || 'Your order is currently being processed for shipping.'}</p>
      <br />
      <p>Thank you.</p>
    `;

    await sendEmail({
      companyId: company_id,
      to: po.factory_email,
      subject: `Shipping Update - PO #${po.po_number}`,
      html: htmlContent
    });

    await logActivity({ company_id, user_id: req.user.user_id, action: 'send_shipping_update', description: `Shipping update sent for PO ${po.po_number}` });
    res.json({ success: true, message: 'Shipping update email sent successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to send shipping update: ' + err.message });
  }
});

// GET /api/purchase-orders/:id/generate-docx
router.get('/:id/generate-docx', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  try {
    const [poRows] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (!poRows[0]) return res.status(404).json({ success: false, message: 'PO not found' });
    const [items] = await pool.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);
    const [compRows] = await pool.query('SELECT * FROM companies WHERE company_id = ?', [company_id]);

    const buffer = await generatePODocx(poRows[0], items, compRows[0] || {});

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poRows[0].po_number}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error generating docx: ' + err.message });
  }
});

// GET /api/purchase-orders/:id/generate-xlsx
router.get('/:id/generate-xlsx', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  try {
    const [poRows] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (!poRows[0]) return res.status(404).json({ success: false, message: 'PO not found' });
    const [items] = await pool.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);
    const [compRows] = await pool.query('SELECT * FROM companies WHERE company_id = ?', [company_id]);

    const buffer = await generatePOXlsx(poRows[0], items, compRows[0] || {});

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PO_${poRows[0].po_number}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error generating xlsx: ' + err.message });
  }
});

const archiver = require('archiver');

// GET /api/purchase-orders/:id/generate-po
router.get('/:id/generate-po', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  try {
    const [poRows] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (!poRows[0]) return res.status(404).json({ success: false, message: 'PO not found' });
    const [items] = await pool.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);
    const [compRows] = await pool.query('SELECT * FROM companies WHERE company_id = ?', [company_id]);

    const po = poRows[0];
    const company = compRows[0] || {};
    const fileBaseName = (po.po_number || `PO_${po_id}`).replace(/[^a-zA-Z0-9_-]/g, '_');

    const docxBuffer = await generatePODocx(po, items, company);
    const xlsxBuffer = await generatePOXlsx(po, items, company);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBaseName}_PO_Files.zip"`);

    const archive = archiver('zip', {
      zlib: { level: 9 } // Sets the compression level.
    });

    archive.on('error', function (err) {
      throw err;
    });

    archive.pipe(res);

    archive.append(docxBuffer, { name: `${fileBaseName}.docx` });
    archive.append(xlsxBuffer, { name: `${fileBaseName}.xlsx` });

    archive.finalize();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error generating PO zip: ' + err.message });
  }
});

// POST /api/purchase-orders/:id/sync-inspectapp
router.post('/:id/sync-inspectapp', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  const conn = await pool.getConnection();
  try {
    const result = await syncToInspectAppHelper(po_id, company_id, conn, req);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/purchase-orders/:id/send-shipping-update
router.post('/:id/send-shipping-update', verifyToken, async (req, res) => {
  const po_id = req.params.id;
  const company_id = req.user.company_id;

  try {
    const [poRows] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (poRows.length === 0) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    const po = poRows[0];

    if (!po.factory_email) {
      return res.status(400).json({ success: false, message: 'Factory email is missing for this PO.' });
    }

    const [items] = await pool.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);

    const xlsxBuffer = await generatePOXlsx(po, items, {});

    const subject = `Shipping Update Request: PO ${po.po_number}`;
    const html = `<p>Please find attached the shipping update form for PO <strong>${po.po_number}</strong>.</p><p>Kindly fill in the shipping details and send it back to us.</p>`;

    await sendEmail({
      companyId: company_id,
      to: po.factory_email,
      subject,
      html,
      attachments: [{
        filename: `Shipping_Update_PO_${po.po_number}.xlsx`,
        content: xlsxBuffer
      }]
    });

    res.json({ success: true, message: 'Shipping update sent successfully.' });
  } catch (err) {
    console.error('Error sending shipping update:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// GET /api/purchase-orders/items/:item_no/track
// Returns all POs that contain the given item_no for this company
router.get('/items/:item_no/track', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const item_no = req.params.item_no;
  try {
    const [rows] = await pool.query(`
      SELECT
        po.id AS po_id,
        po.po_number,
        po.buyer,
        po.po_delivery_date,
        po.status,
        po.sync_status,
        po.last_synced_at,
        pi.id AS item_id,
        pi.item_no,
        pi.item_name,
        pi.description,
        pi.item_picture,
        pi.quantity,
        pi.price,
        pi.inspection_status
      FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.po_id
      WHERE po.company_id = ? AND pi.item_no = ?
      ORDER BY po.po_delivery_date ASC
    `, [company_id, item_no]);

    res.json({ success: true, pos: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/purchase-orders/items/:id/acknowledge-discrepancy
router.post('/items/:id/acknowledge-discrepancy', verifyToken, async (req, res) => {
  const item_id = req.params.id;
  const user_id = req.user.user_id;
  const company_id = req.user.company_id;

  const conn = await pool.getConnection();
  try {
    // Verify item belongs to the user's company
    const [itemRows] = await conn.query(
      `SELECT pi.id FROM po_items pi 
       JOIN purchase_orders po ON pi.po_id = po.id 
       WHERE pi.id = ? AND po.company_id = ?`,
      [item_id, company_id]
    );

    if (itemRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found or unauthorized' });
    }

    await conn.query(
      `UPDATE po_items 
       SET discrepancy_acknowledged_by = ?, discrepancy_acknowledged_at = NOW() 
       WHERE id = ?`,
      [user_id, item_id]
    );

    res.json({ success: true, message: 'Discrepancy acknowledged' });
  } catch (err) {
    console.error('Error acknowledging discrepancy:', err);
    res.status(500).json({ success: false, message: 'Failed to acknowledge discrepancy.' });
  } finally {
    conn.release();
  }
});

// GET /api/purchase-orders/:id/generate-ofc
router.get('/:id/generate-ofc', verifyToken, async (req, res) => {
  const po_id = req.params.id;
  const company_id = req.user.company_id;
  const ExcelJS = require('exceljs');
  const path = require('path');

  try {
    const [pos] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (pos.length === 0) return res.status(404).json({ success: false, message: 'PO not found' });
    const po = pos[0];

    // const [items] = await pool.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);

    const templatePath = path.join(__dirname, '../templates/UAC-OFC-Chart.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);

    // Select the first worksheet
    const worksheet = workbook.worksheets[0];

    // Basic mapping example - we can customize these cells based on the actual UAC-OFC-Chart.xlsx format
    worksheet.getCell('B2').value = po.po_number || '';
    worksheet.getCell('B3').value = po.factory || '';
    worksheet.getCell('B4').value = po.buyer || '';
    if (po.po_delivery_date) {
      worksheet.getCell('B5').value = new Date(po.po_delivery_date).toLocaleDateString();
    }

    // Setting up the response headers for file download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="OFC_Chart_${po.po_number || po.id}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating OFC Excel:', err);
    res.status(500).json({ success: false, message: 'Failed to generate OFC Excel' });
  }
});

module.exports = router;

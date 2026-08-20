const express = require('express');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { distributeDates } = require('../utils/workflowUtils');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

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
          GROUP_CONCAT(DISTINCT pi.description SEPARATOR ', ') AS items_description,
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
  const { po_number, po_date, buyer, buyer_address, factory, factory_email, factory_address, po_delivery_date, special_comments, items } = req.body;

  if (!po_delivery_date) {
    return res.status(400).json({ success: false, message: 'Delivery Date is required' });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const safe_po_date = po_date ? po_date : null;
    const safe_delivery_date = po_delivery_date ? po_delivery_date : null;

    const [result] = await conn.query(
      `INSERT INTO purchase_orders
        (company_id, po_number, po_date, buyer, buyer_address, factory, factory_email, factory_address, po_delivery_date, special_comments, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [company_id, po_number, safe_po_date, buyer, buyer_address, factory, factory_email, factory_address, safe_delivery_date, special_comments]
    );

    const po_id = result.insertId;

    if (Array.isArray(items)) {
      for (const it of items) {
        await conn.query(
          `INSERT INTO po_items (po_id, serial_number, item_no, item_name, description, item_picture, quantity, price, size, eft, finish)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            po_id,
            it.serial_number || null,
            it.item_no || null,
            it.item_name || null,
            it.description || null,
            it.item_picture || null,
            it.quantity || 0,
            it.price || 0,
            it.size || null,
            it.eft || null,
            it.finish || null
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
      `INSERT INTO po_shipments (po_id, shipped_quantity, shipment_date, delivery_date, vessel_name, container_no, bl_no, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [po_id, shipped_quantity, shipment_date, delivery_date, vessel_name, container_no, bl_no, notes]
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

// PUT /api/purchase-orders/:id -> orders/edit_po.php
router.put('/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;
  const { po_number, po_date, buyer, buyer_address, factory, factory_email, factory_address, po_delivery_date, special_comments, status, items } = req.body;

  if (!po_delivery_date) {
    return res.status(400).json({ success: false, message: 'Delivery Date is required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const safe_po_date = po_date ? po_date : null;
    const safe_delivery_date = po_delivery_date ? po_delivery_date : null;

    await conn.query(
      `UPDATE purchase_orders
       SET po_number=?, po_date=?, buyer=?, buyer_address=?, factory=?, factory_email=?, factory_address=?, po_delivery_date=?, special_comments=?, status=?, updated_at=NOW()
       WHERE id=? AND company_id=?`,
      [po_number, safe_po_date, buyer, buyer_address, factory, factory_email, factory_address, safe_delivery_date, special_comments, status, po_id, company_id]
    );

    // Replace items
    await conn.query('DELETE FROM po_items WHERE po_id = ?', [po_id]);
    if (Array.isArray(items)) {
      for (const it of items) {
        await conn.query(
          `INSERT INTO po_items (po_id, serial_number, item_no, item_name, description, item_picture, quantity, price, size, eft, finish)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            po_id,
            it.serial_number || null,
            it.item_no || null,
            it.item_name || null,
            it.description || null,
            it.item_picture || null,
            it.quantity || 0,
            it.price || 0,
            it.size || null,
            it.eft || null,
            it.finish || null
          ]
        );
      }
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

    await conn.commit();
    res.json({ success: true, message: 'Purchase order updated successfully' });
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

// DELETE /api/purchase-orders/:id
router.delete('/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [poRows] = await conn.query('SELECT po_number FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (poRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Purchase order not found' });
    }

    const po_number = poRows[0].po_number;

    await conn.query('DELETE FROM po_items WHERE po_id = ?', [po_id]);
    await conn.query('DELETE FROM po_workflow_schedules WHERE po_id = ?', [po_id]);
    await conn.query('DELETE FROM sync_logs WHERE erp_po_id = ?', [po_id]);
    await conn.query('DELETE FROM purchase_orders WHERE id = ?', [po_id]);

    await conn.commit();
    await logActivity({ company_id, user_id: req.user.user_id, action: 'delete_po', description: `PO ${po_number} deleted` });
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
const excelUpload = multer({ dest: 'uploads/' });

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

// POST /api/purchase-orders/import

// Helper: strip currency symbols / commas and parse price safely
const parsePrice = (val) => {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  // Remove currency symbols, spaces, commas (e.g. "$0.50", "1,200.00", "USD 0.50")
  const cleaned = val.toString().replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
};

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

    if (!row.factory) {
      summary.failed++;
      summary.errors++;
      summary.details.push({ row: index + 1, po_number, item: row.item_no || row.item_name, status: 'failed', reason: 'Factory is required' });
      return; // Skip this row
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
      price: parsePrice(row.price),
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

      if (!group.po_delivery_date) {
        summary.failed++;
        summary.errors++;
        summary.details.push({ po_number, status: 'failed', reason: 'Delivery Date is required — set it in the Global Defaults panel before importing.' });
        continue;
      }

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
          `INSERT INTO po_items (po_id, serial_number, item_no, item_name, description, item_picture, quantity, price, size, eft, finish)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [po_id, it.serial_number, it.item_no, it.item_name, it.description, pic, it.quantity, it.price, it.size, it.eft, it.finish]
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

const { generatePODocx, generatePOXlsx } = require('../utils/documentGenerator');
const { sendEmail } = require('../utils/mailer');

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
  // Define endpoint URLs for potential locations of the InspectApp API
  const inspectAppUrl = process.env.INSPECTAPP_API_URL || 'http://localhost/InspectAppBackup/git 28 july/api/import_purchase_order.php';

  const inspectAppToken = process.env.INSPECTAPP_API_TOKEN || 'f2c_secret_token_123';

  const conn = await pool.getConnection();
  try {
    // 1. Fetch PO and Items
    const [poRows] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);

    if (!poRows[0]) {
      return res.status(404).json({ success: false, message: 'PO not found' });
    }
    const po = poRows[0];

    // Fetch ERP company details
    const [erpCompRows] = await conn.query('SELECT * FROM companies WHERE company_id = ?', [company_id]);
    if (!erpCompRows[0]) {
      return res.status(404).json({ success: false, message: 'ERP Company not found' });
    }

    const erpCompanyName = erpCompRows[0].company_name;

    // Search InspectApp ia_companies table with fuzzy/robust matching in JS
    const [iaCompanies] = await conn.query(
      'SELECT id, company_name, status, subscription_expires_at FROM uaconsu1_inspectapp.ia_companies'
    );

    const normalizeCompanyName = (name) => {
      if (!name) return '';
      return name.toLowerCase()
        .replace(/[^a-z0-9]/g, '') // remove non-alphanumeric
        .replace(/(ltd|limited|inc|co|corp|consultants|consultant)$/g, '') // remove suffixes
        .replace(/s$/g, ''); // remove plural 's' at end
    };

    const targetNormal = normalizeCompanyName(erpCompanyName);

    // 1. Exact cleaned match
    let iaCompany = iaCompanies.find(c => normalizeCompanyName(c.company_name) === targetNormal);

    // 2. Fallback to partial inclusion match
    if (!iaCompany) {
      iaCompany = iaCompanies.find(c => {
        const cNormal = normalizeCompanyName(c.company_name);
        return cNormal.length > 1 && targetNormal.length > 1 && (cNormal.includes(targetNormal) || targetNormal.includes(cNormal));
      });
    }

    if (!iaCompany) {
      return res.status(400).json({
        success: false,
        status: 'not_linked',
        message: 'Your company is not linked with InspectApp. You can link your InspectApp from here.'
      });
    }

    // Verify status = 'approved' (or active)
    if (iaCompany.status !== 'approved' && iaCompany.status !== 'active') {
      return res.status(400).json({
        success: false,
        status: 'inactive',
        message: `Your InspectApp account status is '${iaCompany.status}'. Please contact InspectApp admin.`
      });
    }

    // Verify subscription_expires_at is NULL or >= CURRENT_DATE
    if (iaCompany.subscription_expires_at) {
      const expiryDate = new Date(iaCompany.subscription_expires_at);
      const currentDate = new Date();
      expiryDate.setHours(0, 0, 0, 0);
      currentDate.setHours(0, 0, 0, 0);
      if (expiryDate < currentDate) {
        return res.status(400).json({
          success: false,
          status: 'expired',
          message: 'Your InspectApp subscription has expired. Please renew your subscription.'
        });
      }
    }

    const [items] = await conn.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);

    // 2. Prepare Payload
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

        return {
          erp_item_id: item.id,
          item_number: item.item_no || '',
          item_name: item.item_name || '',
          order_quantity: item.quantity || 0,
          material: item.material || '',
          finish: item.finish || '',
          weight: item.weight || '',
          length: l,
          width: w,
          height: h,
          upc: item.upc || '',
          product_image_url: item.item_picture || '',
          pieces_to_assemble: item.pieces_to_assemble || 0
        };
      })
    };

    // 3. Send POST Request to InspectApp
    const response = await fetch(inspectAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${inspectAppToken}`
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.text();

    let parsedResponse = {};

    try {
      parsedResponse = JSON.parse(responseData);
    } catch (e) {
      parsedResponse = { message: responseData };
    }

    // 4. Handle Response & Log
    if (response.ok && parsedResponse.status === 'success') {
      await conn.query(
        'UPDATE purchase_orders SET sync_status = ?, last_synced_at = NOW() WHERE id = ?',
        ['Synced', po_id]
      );
      await conn.query(
        'INSERT INTO sync_logs (erp_po_id, status, response) VALUES (?, ?, ?)',
        [po_id, 'Synced', JSON.stringify(parsedResponse)]
      );
      const [[updatedPo]] = await conn.query('SELECT sync_status, last_synced_at FROM purchase_orders WHERE id = ?', [po_id]);
      res.json({ success: true, message: 'Synced to InspectApp successfully', sync_status: updatedPo.sync_status, last_synced_at: updatedPo.last_synced_at });
    } else {
      const errMsg = parsedResponse.message || `HTTP ${response.status}: Unknown error`;
      await conn.query(
        'UPDATE purchase_orders SET sync_status = ?, last_synced_at = NOW() WHERE id = ?',
        ['Sync Failed', po_id]
      );
      await conn.query(
        'INSERT INTO sync_logs (erp_po_id, status, response, error) VALUES (?, ?, ?, ?)',
        [po_id, 'Sync Failed', JSON.stringify(parsedResponse), errMsg]
      );
      const [[updatedPo]] = await conn.query('SELECT sync_status, last_synced_at FROM purchase_orders WHERE id = ?', [po_id]);
      res.status(400).json({ success: false, message: 'Sync failed: ' + errMsg, sync_status: updatedPo.sync_status, last_synced_at: updatedPo.last_synced_at });
    }

  } catch (err) {
    try {
      await conn.query(
        'UPDATE purchase_orders SET sync_status = ?, last_synced_at = NOW() WHERE id = ?',
        ['Sync Failed', po_id]
      );
      await conn.query(
        'INSERT INTO sync_logs (erp_po_id, status, error) VALUES (?, ?, ?)',
        [po_id, 'Sync Failed', err.message]
      );
    } catch (_) { }
    const [[updatedPo]] = await conn.query('SELECT sync_status, last_synced_at FROM purchase_orders WHERE id = ?', [po_id]).catch(() => [[{}]]);
    res.status(500).json({ success: false, message: 'Error syncing to InspectApp: ' + err.message, sync_status: updatedPo?.sync_status, last_synced_at: updatedPo?.last_synced_at });
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

module.exports = router;

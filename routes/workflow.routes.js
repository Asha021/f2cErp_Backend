const express = require('express');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { distributeDates, recalculateAllActivePOs } = require('../utils/workflowUtils');

const router = express.Router();

// ----------------------------------------------------
// TEMPLATES & VERSIONS
// ----------------------------------------------------

router.get('/templates', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  try {
    const [templates] = await pool.query('SELECT * FROM workflow_templates WHERE company_id = ?', [company_id]);
    
    // Get active versions
    for (let t of templates) {
        const [versions] = await pool.query('SELECT * FROM workflow_template_versions WHERE template_id = ? ORDER BY version_number DESC', [t.id]);
        t.versions = versions;
        t.active_version = versions.find(v => v.is_active) || null;
    }
    
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// CALENDARS
// ----------------------------------------------------

router.get('/calendars', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  try {
    const [workingDays] = await pool.query('SELECT * FROM working_days WHERE company_id = ? ORDER BY day_of_week ASC', [company_id]);
    const [holidays] = await pool.query('SELECT * FROM holiday_calendars WHERE company_id = ? ORDER BY holiday_date ASC', [company_id]);
    res.json({ success: true, workingDays, holidays });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/calendars/holiday', verifyToken, async (req, res) => {
    const company_id = req.user.company_id;
    const { holiday_date, description } = req.body;
    try {
        await pool.query('INSERT INTO holiday_calendars (company_id, holiday_date, description) VALUES (?, ?, ?)', [company_id, holiday_date, description]);
        res.json({ success: true, message: 'Holiday added' });
    } catch(err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put('/calendars/working-days', verifyToken, async (req, res) => {
    const company_id = req.user.company_id;
    const { days } = req.body; // Array of {day_of_week, is_working}
    try {
        for (let d of days) {
            await pool.query('UPDATE working_days SET is_working = ? WHERE company_id = ? AND day_of_week = ?', [d.is_working, company_id, d.day_of_week]);
        }
        res.json({ success: true, message: 'Working days updated' });
    } catch(err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------------------------------
// STAGES
// ----------------------------------------------------

router.get('/stages', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  try {
    // Get active template version for company
    const [activeVersions] = await pool.query(`
        SELECT v.id FROM workflow_template_versions v
        JOIN workflow_templates t ON v.template_id = t.id
        WHERE t.company_id = ? AND v.is_active = TRUE LIMIT 1
    `, [company_id]);

    if (activeVersions.length === 0) {
        return res.json({ success: true, stages: [] });
    }

    const version_id = activeVersions[0].id;
    const [stages] = await pool.query(
      'SELECT id, stage_name as name, order_index, is_enabled, color, allocation_type, allocation_value, dependencies FROM production_stages WHERE template_version_id = ? ORDER BY order_index ASC',
      [version_id]
    );
    res.json({ success: true, stages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/stages', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { name, order_index, color, allocation_type, allocation_value } = req.body;
  
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let version_id;
    const [activeVersions] = await conn.query(`
        SELECT v.id FROM workflow_template_versions v
        JOIN workflow_templates t ON v.template_id = t.id
        WHERE t.company_id = ? AND v.is_active = TRUE LIMIT 1
    `, [company_id]);

    if (activeVersions.length === 0) {
        // Auto-create a default template for this company
        const [tempRes] = await conn.query(
            'INSERT INTO workflow_templates (company_id, name, description) VALUES (?, ?, ?)',
            [company_id, 'Default Template', 'Automatically generated template']
        );
        const [verRes] = await conn.query(
            'INSERT INTO workflow_template_versions (template_id, version_number, is_active) VALUES (?, ?, ?)',
            [tempRes.insertId, 1, true]
        );
        version_id = verRes.insertId;
    } else {
        version_id = activeVersions[0].id;
    }

    // Shift subsequent stages
    await conn.query(
      'UPDATE production_stages SET order_index = order_index + 1 WHERE template_version_id = ? AND order_index >= ?',
      [version_id, order_index]
    );

    // Insert new stage
    const [result] = await conn.query(
      'INSERT INTO production_stages (company_id, template_version_id, stage_name, order_index, color, allocation_type, allocation_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [company_id, version_id, name, order_index, color || '#4F46E5', allocation_type || 'equal', allocation_value || null]
    );

    await conn.commit();
    
    // Background recalculation of all active POs
    recalculateAllActivePOs(pool, company_id).catch(console.error);
    
    res.json({ success: true, message: 'Stage added' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

router.delete('/stages/:id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const stage_id = req.params.id;
  
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Verify stage belongs to company
    const [stage] = await conn.query('SELECT order_index, template_version_id FROM production_stages WHERE id = ? AND company_id = ?', [stage_id, company_id]);
    if (stage.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Stage not found' });
    }
    const { order_index, template_version_id } = stage[0];

    // Delete stage
    await conn.query('DELETE FROM production_stages WHERE id = ?', [stage_id]);

    // Shift subsequent stages back
    await conn.query(
      'UPDATE production_stages SET order_index = order_index - 1 WHERE template_version_id = ? AND order_index > ?',
      [template_version_id, order_index]
    );

    // Also delete any existing schedules for this stage to maintain integrity
    await conn.query('DELETE FROM po_workflow_schedules WHERE stage_id = ?', [stage_id]);

    await conn.commit();

    // Background recalculation
    recalculateAllActivePOs(pool, company_id).catch(console.error);

    res.json({ success: true, message: 'Stage deleted' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

router.put('/stages/reorder', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { stages } = req.body; // Array of { id, order_index }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const stage of stages) {
      await conn.query(
        'UPDATE production_stages SET order_index = ? WHERE id = ? AND company_id = ?',
        [stage.order_index, stage.id, company_id]
      );
    }
    await conn.commit();

    // Background recalculation
    recalculateAllActivePOs(pool, company_id).catch(console.error);

    res.json({ success: true, message: 'Stages reordered' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
});

// ----------------------------------------------------
// PO WORKFLOW SCHEDULING
// ----------------------------------------------------

router.get('/po/:po_id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.po_id;
  
  try {
    const [poRows] = await pool.query('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (poRows.length === 0) return res.status(404).json({ success: false, message: 'PO not found' });
    
    const poData = poRows[0];

    // Fetch items
    const [items] = await pool.query('SELECT * FROM po_items WHERE po_id = ?', [po_id]);
    poData.items = items;
    poData.total_quantity = items.reduce((sum, it) => sum + (it.quantity || 0), 0);
    poData.item_count = items.length;

    // Fetch shipments summary
    const [shipments] = await pool.query('SELECT SUM(shipped_quantity) as total_shipped FROM po_shipments WHERE po_id = ?', [po_id]);
    poData.shipped_quantity = shipments[0].total_shipped || 0;
    poData.pending_quantity = Math.max(0, poData.total_quantity - poData.shipped_quantity);

    const [timeline] = await pool.query(`
      SELECT 
        ps.*, 
        stg.stage_name as stage_name, 
        stg.order_index,
        stg.color
      FROM po_workflow_schedules ps
      JOIN production_stages stg ON ps.stage_id = stg.id
      WHERE ps.po_id = ?
      ORDER BY stg.order_index ASC
    `, [po_id]);

    res.json({ success: true, timeline, po: poData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/po/:po_id/stage/:stage_id', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const { po_id, stage_id } = req.params;
  const { scheduled_start_date, scheduled_end_date, actual_start_date, actual_end_date, status, notes } = req.body;

  try {
    const [poCheck] = await pool.query('SELECT id FROM purchase_orders WHERE id = ? AND company_id = ?', [po_id, company_id]);
    if (poCheck.length === 0) return res.status(404).json({ success: false, message: 'PO not found' });

    await pool.query(`
      UPDATE po_workflow_schedules 
      SET scheduled_start_date = ?, scheduled_end_date = ?, 
          actual_start_date = ?, actual_end_date = ?, 
          status = ?, notes = ?
      WHERE po_id = ? AND stage_id = ?
    `, [
      scheduled_start_date || null, 
      scheduled_end_date || null,
      actual_start_date || null, 
      actual_end_date || null,
      status || 'pending', notes || '',
      po_id, stage_id
    ]);

    // Insert Audit log
    await pool.query(`INSERT INTO workflow_audit_logs (company_id, po_id, action, description, changed_by) VALUES (?, ?, ?, ?, ?)`, 
        [company_id, po_id, 'STATUS_UPDATE', `Stage ${stage_id} updated to ${status}`, req.user.user_id]);

    res.json({ success: true, message: 'Schedule updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/po/:po_id/audit', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.po_id;
  try {
    const [logs] = await pool.query(`
      SELECT a.*, CONCAT(u.first_name, ' ', u.last_name) as user_name 
      FROM workflow_audit_logs a 
      LEFT JOIN users u ON a.changed_by = u.user_id 
      WHERE a.po_id = ? AND a.company_id = ? 
      ORDER BY a.created_at DESC
    `, [po_id, company_id]);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/po/:po_id/shipments', verifyToken, async (req, res) => {
  const po_id = req.params.po_id;
  try {
    const [shipments] = await pool.query(`
      SELECT s.*, CONCAT(u.first_name, ' ', u.last_name) as user_name
      FROM po_shipments s
      LEFT JOIN users u ON s.created_by = u.user_id
      WHERE s.po_id = ?
      ORDER BY s.created_at DESC
    `, [po_id]);
    res.json({ success: true, shipments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/po/:po_id/shipments', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  const po_id = req.params.po_id;
  const { shipped_quantity, shipment_date, notes } = req.body;
  try {
    await pool.query(
      'INSERT INTO po_shipments (company_id, po_id, shipped_quantity, shipment_date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [company_id, po_id, shipped_quantity, shipment_date || null, notes || '', req.user.user_id]
    );
    // Log audit
    await pool.query(`INSERT INTO workflow_audit_logs (company_id, po_id, action, description, changed_by) VALUES (?, ?, ?, ?, ?)`, 
        [company_id, po_id, 'SHIPMENT_ADDED', `Added shipment of ${shipped_quantity} units`, req.user.user_id]);

    res.json({ success: true, message: 'Shipment added' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/po/:po_id/shipments/:shipment_id', verifyToken, async (req, res) => {
  const { po_id, shipment_id } = req.params;
  try {
    await pool.query('DELETE FROM po_shipments WHERE id = ? AND po_id = ?', [shipment_id, po_id]);
    res.json({ success: true, message: 'Shipment deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/po/:po_id/report/email', verifyToken, async (req, res) => {
    // Mock email functionality
    const { po_id } = req.params;
    const { recipients } = req.body;
    
    // Here we would normally compile HTML and send via nodemailer
    res.json({ success: true, message: `Email sent to ${recipients.join(', ')}` });
});

router.get('/dashboard', verifyToken, async (req, res) => {
  const company_id = req.user.company_id;
  try {
    // Quick legacy dashboard
    const [stages] = await pool.query(
      'SELECT id, stage_name as name, order_index, color FROM production_stages WHERE company_id = ? ORDER BY order_index ASC LIMIT 10',
      [company_id]
    );

    const [pos] = await pool.query(`
      SELECT 
        po.id, po.po_number, po.factory, po.po_date, po.po_delivery_date,
        (
          SELECT ps.stage_id
          FROM po_workflow_schedules ps
          JOIN production_stages stg ON ps.stage_id = stg.id
          WHERE ps.po_id = po.id AND ps.status NOT IN ('completed', 'cancelled')
          ORDER BY stg.order_index ASC
          LIMIT 1
        ) as current_stage_id
      FROM purchase_orders po
      WHERE po.company_id = ? AND po.status != 'completed'
    `, [company_id]);

    const dashboard = stages.map(stg => ({
      ...stg,
      po_count: 0,
      pos: []
    }));

    pos.forEach(po => {
      let stageIndex = -1;
      if (po.current_stage_id) {
        stageIndex = dashboard.findIndex(s => s.id === po.current_stage_id);
      }
      if (stageIndex >= 0) {
        dashboard[stageIndex].po_count++;
        dashboard[stageIndex].pos.push(po);
      }
    });

    res.json({ success: true, dashboard });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

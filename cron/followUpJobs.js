const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');

async function runDailyStageFollowUp(options = {}) {
  console.log('Running daily stage follow-up job...');
  const summary = { totalPOs: 0, sentCount: 0, errors: [] };
  const dateFilter = options.all ? '' : 'AND pws.scheduled_end_date = CURRENT_DATE()';
  try {
    const [stages] = await pool.query(`
      SELECT 
        po.id as po_id, po.po_number, po.factory_email, po.company_id,
        c.email as company_email, c.company_name,
        ps.stage_name, 
        pws.scheduled_end_date,
        pi.id as item_id, pi.item_no, pi.item_name, pi.description, pi.quantity
      FROM purchase_orders po
      JOIN companies c ON po.company_id = c.company_id
      JOIN po_workflow_schedules pws ON po.id = pws.po_id
      JOIN production_stages ps ON pws.stage_id = ps.id
      LEFT JOIN po_items pi ON po.id = pi.po_id
      WHERE po.status != 'completed' AND po.status != 'cancelled'
      AND (LOWER(c.status) = 'active' OR c.status IS NULL OR c.status = '1')
      AND pws.actual_end_date IS NULL
      ${dateFilter}
      ORDER BY po.id ASC, ps.order_index ASC, pi.id ASC
    `);

    if (stages.length === 0) {
      console.log('No stages scheduled for today.');
      return { ...summary, message: 'No stages scheduled for today' };
    }

    const poGroups = {};
    stages.forEach(row => {
      if (!row.company_email) return;
      if (!poGroups[row.po_id]) {
        poGroups[row.po_id] = {
          company_id: row.company_id,
          company_name: row.company_name,
          company_email: row.company_email,
          po_number: row.po_number,
          items: []
        };
      }

      const dateStr = new Date(row.scheduled_end_date).toLocaleDateString('en-GB');
      poGroups[row.po_id].items.push({
        item_no: row.item_no || '-',
        description: row.description || row.item_name || '-',
        quantity: row.quantity !== null && row.quantity !== undefined ? row.quantity : '-',
        stage_name: row.stage_name,
        dateStr: dateStr,
        status: 'Scheduled for today'
      });
    });

    summary.totalPOs = Object.keys(poGroups).length;

    for (const poId in poGroups) {
      const poData = poGroups[poId];
      let itemRows = '';
      poData.items.forEach((item, idx) => {
        const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        itemRows += `
          <tr style="background-color: ${bgColor};">
            <td style="padding: 9px 8px; text-align: center; color: #64748b; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px; width: 36px;">${idx + 1}</td>
            <td style="padding: 9px 10px; font-weight: 600; color: #0f172a; white-space: nowrap; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${item.item_no}</td>
            <td style="padding: 9px 10px; color: #334155; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${item.description}</td>
            <td style="padding: 9px 10px; text-align: center; color: #0f172a; font-weight: 600; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${item.quantity}</td>
            <td style="padding: 9px 10px; font-weight: 600; color: #0f172a; white-space: nowrap; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${item.stage_name}</td>
            <td style="padding: 9px 10px; color: #334155; white-space: nowrap; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${item.dateStr}</td>
            <td style="padding: 9px 10px; color: #0284c7; font-weight: 600; white-space: nowrap; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${item.status}</td>
          </tr>
        `;
      });

      const reminderMessage = `
        <div style="font-family: Arial, Helvetica, sans-serif; margin: 0 auto; max-width: 720px; padding: 12px 6px; color: #1e293b;">
          <!--[if (gte mso 9)|(IE)]>
          <table align="center" border="0" cellspacing="0" cellpadding="0" width="720">
          <tr><td>
          <![endif]-->
          <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="width: 100%; max-width: 720px; margin: 0 auto; border-collapse: collapse;">
            <tr>
              <td style="padding: 0 0 14px 0; font-family: Arial, sans-serif;">
                <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #0f172a; font-family: Arial, sans-serif;">PO #${poData.po_number} - Stage Alert</p>
                <p style="margin: 0; font-size: 13px; color: #475569; font-family: Arial, sans-serif;">The following stage(s) and item(s) are scheduled for today:</p>
              </td>
            </tr>
            <tr>
              <td style="padding: 0; font-family: Arial, sans-serif;">
                <table border="1" cellpadding="0" cellspacing="0" width="100%" style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">
                  <thead>
                    <tr style="background-color: #f1f5f9; color: #475569;">
                      <th style="padding: 9px 8px; font-size: 11px; font-weight: 600; text-align: center; border: 1px solid #cbd5e1; width: 36px; font-family: Arial, sans-serif;">S.NO</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; white-space: nowrap; font-family: Arial, sans-serif;">ITEM NO</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; font-family: Arial, sans-serif;">DESCRIPTION</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: center; border: 1px solid #cbd5e1; white-space: nowrap; font-family: Arial, sans-serif;">ORDER QTY</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; white-space: nowrap; font-family: Arial, sans-serif;">STAGE</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; white-space: nowrap; font-family: Arial, sans-serif;">SCHEDULED DATE</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; white-space: nowrap; font-family: Arial, sans-serif;">STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${itemRows}
                  </tbody>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 18px 0 0 0; font-size: 11px; color: #94a3b8; text-align: center; font-family: Arial, sans-serif;">
                Automated Stage Notification &bull; ERP System
              </td>
            </tr>
          </table>
          <!--[if (gte mso 9)|(IE)]>
          </td></tr>
          </table>
          <![endif]-->
        </div>
      `;

      if (!poData.company_email) continue;

      try {
        await sendEmail({
          companyId: poData.company_id,
          to: poData.company_email,
          subject: `Daily Stage Alert - PO #${poData.po_number}`,
          html: reminderMessage
        });
        summary.sentCount++;
        console.log(`Sent stage alert for PO #${poData.po_number} to company: ${poData.company_email}`);
      } catch (err) {
        summary.errors.push({ po: poData.po_number, error: err.message });
        console.error(`Failed to send reminder for PO ${poData.po_number}:`, err.message);
      }
    }
    return summary;
  } catch (err) {
    console.error('Error running daily cron job:', err);
    throw err;
  }
}

async function runWeeklyConsolidatedReport(options = {}) {
  const days = options.days || 7;
  const ignoreDates = options.ignoreDates || false;
  console.log(`Running weekly consolidated report job (days=${days}, ignoreDates=${ignoreDates})...`);
  const summary = { totalCompanies: 0, sentCount: 0, errors: [] };
  try {
    let dateFilter = `AND po.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`;
    if (ignoreDates) {
      dateFilter = '';
    }

    // Missing Delivery Dates for POs (case-insensitive company status, flexible date)
    const [missingDeliveryDatePOs] = await pool.query(`
      SELECT 
        po.id as po_id, po.po_number, po.po_date, po.created_at, po.company_id, po.factory,
        c.email as company_email, c.company_name, c.status as company_status
      FROM purchase_orders po
      JOIN companies c ON po.company_id = c.company_id
      WHERE po.status != 'completed' AND po.status != 'cancelled'
      AND (LOWER(c.status) = 'active' OR c.status IS NULL OR c.status = '1')
      AND (po.po_delivery_date IS NULL OR po.po_delivery_date = '' OR po.po_delivery_date = '0000-00-00 00:00:00')
      ${dateFilter}
      GROUP BY po.id, c.email, c.company_name, c.status
      ORDER BY po.created_at DESC
    `);

    if (missingDeliveryDatePOs.length === 0) {
      console.log('No POs missing delivery date found for current filter.');
      try {
        const [counts] = await pool.query(`
          SELECT 
            (SELECT COUNT(*) FROM purchase_orders) as total_pos_in_db,
            (SELECT COUNT(*) FROM purchase_orders WHERE (po_delivery_date IS NULL OR po_delivery_date = '' OR po_delivery_date = '0000-00-00 00:00:00')) as pos_without_delivery_date,
            (SELECT COUNT(*) FROM purchase_orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)) as pos_in_past_days
          FROM DUAL
        `, [days]);
        const [recentPOs] = await pool.query(`
          SELECT id, po_number, created_at, status, company_id, po_delivery_date 
          FROM purchase_orders ORDER BY id DESC LIMIT 5
        `);
        const [companies] = await pool.query(`
          SELECT company_id, company_name, email, status FROM companies
        `);
        summary.diagnostics = {
          counts: counts[0],
          recentPOs,
          companies,
          note: `0 POs matched criteria: po.status NOT IN ('completed','cancelled') AND po_delivery_date IS NULL AND created_at within ${days} days`
        };
      } catch (diagErr) {
        summary.diagError = diagErr.message;
      }
      return summary;
    }

    // Group all by company
    const companyGroups = {};

    // Process missing dates
    missingDeliveryDatePOs.forEach(row => {
      if (!row.company_email) return;
      if (!companyGroups[row.company_id]) {
        companyGroups[row.company_id] = {
          company_email: row.company_email,
          company_name: row.company_name,
          missing_pos: []
        };
      }
      companyGroups[row.company_id].missing_pos.push(row);
    });

    summary.totalCompanies = Object.keys(companyGroups).length;

    // Generate emails
    for (const compId in companyGroups) {
      const compData = companyGroups[compId];

      if (compData.missing_pos.length === 0) continue;

      let rowsHtml = '';
      compData.missing_pos.forEach((po, idx) => {
        const rawDate = po.po_date || po.created_at;
        const formattedDate = rawDate ? new Date(rawDate).toLocaleDateString('en-GB') : '-';
        const bgColor = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
        rowsHtml += `
          <tr style="background-color: ${bgColor};">
            <td style="padding: 9px 8px; text-align: center; color: #64748b; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px; width: 36px;">${idx + 1}</td>
            <td style="padding: 9px 10px; font-weight: 600; color: #0f172a; white-space: nowrap; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${po.po_number || '-'}</td>
            <td style="padding: 9px 10px; color: #334155; white-space: nowrap; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${formattedDate}</td>
            <td style="padding: 9px 10px; color: #334155; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">${po.factory || '-'}</td>
          </tr>
        `;
      });

      const messageHtml = `
        <div style="font-family: Arial, Helvetica, sans-serif; margin: 0 auto; max-width: 600px; padding: 12px 6px; color: #1e293b;">
          <!--[if (gte mso 9)|(IE)]>
          <table align="center" border="0" cellspacing="0" cellpadding="0" width="600">
          <tr><td>
          <![endif]-->
          <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="width: 100%; max-width: 600px; margin: 0 auto; border-collapse: collapse;">
            <tr>
              <td style="padding: 0 0 14px 0; font-family: Arial, sans-serif;">
                <p style="margin: 0 0 6px 0; font-size: 15px; font-weight: bold; color: #0f172a; font-family: Arial, sans-serif;">Hello ${compData.company_name} Team,</p>
                <p style="margin: 0; font-size: 13px; color: #475569; font-family: Arial, sans-serif;">Please update the <strong>Delivery Date</strong> for the following Purchase Orders:</p>
              </td>
            </tr>
            <tr>
              <td style="padding: 0; font-family: Arial, sans-serif;">
                <table border="1" cellpadding="0" cellspacing="0" width="100%" style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; font-family: Arial, sans-serif; font-size: 12px;">
                  <thead>
                    <tr style="background-color: #f1f5f9; color: #475569;">
                      <th style="padding: 9px 8px; font-size: 11px; font-weight: 600; text-align: center; border: 1px solid #cbd5e1; width: 36px; font-family: Arial, sans-serif;">S.NO</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; white-space: nowrap; font-family: Arial, sans-serif;">PO NUMBER</th>
                      <th style="padding: 9px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; white-space: nowrap; font-family: Arial, sans-serif;">PO DATE</th>
                      <th style="padding: 10px 10px; font-size: 11px; font-weight: 600; text-align: left; border: 1px solid #cbd5e1; font-family: Arial, sans-serif;">FACTORY</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rowsHtml}
                  </tbody>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 18px 0 0 0; font-size: 11px; color: #94a3b8; text-align: center; font-family: Arial, sans-serif;">
                Automated OFC Notification &bull; ERP System
              </td>
            </tr>
          </table>
          <!--[if (gte mso 9)|(IE)]>
          </td></tr>
          </table>
          <![endif]-->
        </div>
      `;

      try {
        await sendEmail({
          companyId: compId,
          to: compData.company_email,
          subject: 'PENDING UPDATION',
          html: messageHtml
        });
        summary.sentCount++;
        console.log(`Sent weekly report to ${compData.company_name} (${compData.company_email})`);
      } catch (err) {
        summary.errors.push({ company: compData.company_name, email: compData.company_email, error: err.message });
        console.error(`Error sending weekly report to ${compData.company_name}:`, err.message);
      }
    }
    return summary;
  } catch (err) {
    console.error('Error in weekly consolidated job:', err);
    throw err;
  }
}

function initCronJobs() {
  // 1. Daily Follow-up for stages scheduled TODAY (Daily at 12:00 PM IST)
  // cron.schedule('0 12 * * *', async () => {
  cron.schedule('*/1 * * * *', async () => {
    try {
      await runDailyStageFollowUp();
    } catch (err) {
      console.error('Scheduled daily stage job failed:', err.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // 2. Weekly Consolidated Report (Saturdays at 12:00 PM IST)
  cron.schedule('0 12 * * 6', async () => {
    try {
      await runWeeklyConsolidatedReport();
    } catch (err) {
      console.error('Scheduled weekly report job failed:', err.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });
}

module.exports = {
  initCronJobs,
  runDailyStageFollowUp,
  runWeeklyConsolidatedReport
};

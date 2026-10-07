const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');

function initCronJobs() {
  // 1. Daily Follow-up for stages scheduled TODAY (or delayed)
  // cron.schedule('0 8 * * *', async () => {
  cron.schedule('*/1 * * * *', async () => {
    console.log('Running daily stage follow-up job...');
    try {
      const [stages] = await pool.query(`
        SELECT 
          po.id as po_id, po.po_number, po.factory_email, po.company_id,
          ps.stage_name, 
          pws.scheduled_end_date,
          DATEDIFF(CURRENT_DATE(), pws.scheduled_end_date) as days_late
        FROM purchase_orders po
        JOIN po_workflow_schedules pws ON po.id = pws.po_id
        JOIN production_stages ps ON pws.stage_id = ps.id
        WHERE po.status != 'completed' AND po.status != 'cancelled'
        AND pws.actual_end_date IS NULL
        AND pws.scheduled_end_date <= CURRENT_DATE()
      `);

      if (stages.length === 0) {
        console.log('No stages found for today or delayed.');
        return;
      }

      const poGroups = {};
      stages.forEach(row => {
        if (!row.factory_email) return;
        if (!poGroups[row.po_id]) {
          poGroups[row.po_id] = {
            company_id: row.company_id,
            po_number: row.po_number,
            factory_email: row.factory_email,
            stages: []
          };
        }
        poGroups[row.po_id].stages.push(row);
      });

      for (const poId in poGroups) {
        const poData = poGroups[poId];
        let stagesHtml = `
          <h3 style="margin-bottom: 8px; color: #1e293b; font-size: 14px;">PO #${poData.po_number}</h3>
          <table style="width: 100%; max-width: 600px; border-collapse: collapse; text-align: left; font-size: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px; font-family: sans-serif;">
            <tr style="background-color: #f8fafc; border-bottom: 1px solid #cbd5e1; color: #475569; text-transform: uppercase;">
              <th style="padding: 10px; font-weight: 600;">STAGE</th>
              <th style="padding: 10px; font-weight: 600;">SCHEDULED DATE</th>
              <th style="padding: 10px; font-weight: 600;">STATUS</th>
            </tr>
        `;
        poData.stages.forEach(stage => {
          const dateStr = new Date(stage.scheduled_end_date).toLocaleDateString();
          let statusText = 'pending';
          if (stage.days_late > 0) {
            statusText = `pending (Delayed by ${stage.days_late} days)`;
          }
          stagesHtml += `
            <tr style="border-bottom: 1px solid #f1f5f9; color: #334155;">
              <td style="padding: 10px; font-weight: 500;">${stage.stage_name}</td>
              <td style="padding: 10px;">${dateStr}</td>
              <td style="padding: 10px;"><em>${statusText}</em></td>
            </tr>
          `;
        });
        stagesHtml += `</table>`;

        const reminderMessage = `
          <div style="font-family: Arial, sans-serif; padding: 30px; max-width: 800px; margin: 0 auto; background-color: #ffffff; color: #333333;">
            <p style="font-size: 14px; margin-bottom: 20px;">The following stages are scheduled for today or delayed. Please ensure they are updated.</p>
            ${stagesHtml}
            <div style="margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px;">
              This is an automated daily notification from your ERP system. Please do not reply.
            </div>
          </div>
        `;

        try {
          await sendEmail({
            companyId: poData.company_id,
            to: poData.factory_email,
            subject: `Daily Stage Alert - PO #${poData.po_number}`,
            html: reminderMessage
          });
        } catch (err) {
          console.error(`Failed to send reminder for PO ${poData.po_number}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Error running daily cron job:', err);
    }
  });


  // 2. Weekly Consolidated Report (Saturdays at 11:00 AM)
  cron.schedule('0 11 * * 6', async () => {
  // cron.schedule('*/1 * * * *', async () => {
    console.log('Running weekly consolidated report job...');
    try {
      // A. Missing Delivery Dates
      const [missingDeliveryDatePOs] = await pool.query(`
        SELECT 
          po.id as po_id, po.po_number, po.created_at, po.company_id, po.buyer,
          c.email as company_email, c.company_name,
          SUM(pi.quantity * pi.price) as total_value,
          MAX(pi.currency) as currency
        FROM purchase_orders po
        JOIN companies c ON po.company_id = c.company_id
        LEFT JOIN po_items pi ON po.id = pi.po_id
        WHERE po.po_delivery_date IS NULL OR po.po_delivery_date = '' OR po.po_delivery_date = '0000-00-00 00:00:00'
        GROUP BY po.id, c.email, c.company_name
      `);

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

      // Generate emails
      for (const compId in companyGroups) {
        const compData = companyGroups[compId];

        let poListHtml = '';
        if (compData.missing_pos.length > 0) {
          poListHtml += `
            <p style="font-size: 14px; margin-bottom: 20px; color: #374151;">This is your weekly OFC (Order Follow-up Chart) alert. The following Purchase Orders are currently missing a <strong>Delivery Date</strong>.</p>
            <div style="background-color: #fdf2f2; border-left: 3px solid #ef4444; padding: 12px 16px; margin-bottom: 24px;">
              <strong style="color: #b91c1c; font-size: 14px; display: block; margin-bottom: 4px;">Action Required</strong>
              <span style="color: #b91c1c; font-size: 13px;">Please update the Delivery Date for these POs in the system. OFC cannot be generated until the Delivery Date is available.</span>
            </div>
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 11px; border: 1px solid #e5e7eb; margin-bottom: 24px; font-family: sans-serif;">
              <tr style="background-color: #f8fafc; border-bottom: 1px solid #cbd5e1; text-transform: uppercase; color: #475569;">
                <th style="padding: 10px; font-weight: 600;">S.NO</th>
                <th style="padding: 10px; font-weight: 600;">PO NUMBER</th>
                <th style="padding: 10px; font-weight: 600;">BUYER ID</th>
                <th style="padding: 10px; font-weight: 600;">VALUE</th>
              </tr>
          `;
          compData.missing_pos.forEach((po, idx) => {
            const val = po.total_value ? (po.currency || '$') + ' ' + po.total_value : '-';
            const buyerId = po.buyer || '-';
            poListHtml += `
              <tr style="border-bottom: 1px solid #f1f5f9; color: #334155;">
                <td style="padding: 10px;">${idx + 1}</td>
                <td style="padding: 10px; font-weight: 600;">${po.po_number || '-'}</td>
                <td style="padding: 10px;">${buyerId}</td>
                <td style="padding: 10px;">${val}</td>
              </tr>
            `;
          });
          poListHtml += `
            </table>
            <p style="font-size: 13px; color: #475569; margin-top: 24px;">Once the Delivery Dates are updated, the OFC can be generated normally.</p>
            <p style="font-size: 13px; color: #475569;">Thank you.</p>
          `;
        }

        if (poListHtml === '') continue;

        const messageHtml = `
          <div style="font-family: Arial, sans-serif; padding: 30px; max-width: 800px; margin: 0 auto; background-color: #ffffff; color: #333333;">
            <p style="font-size: 14px; margin-bottom: 20px;">Hello <strong>${compData.company_name} Team</strong>,</p>
            ${poListHtml}
            <div style="margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px; text-align: center;">
              This is an automated weekly notification from your ERP system. Please do not reply.
            </div>
          </div>
        `;

        try {
          await sendEmail({
            companyId: compId,
            to: compData.company_email,
            subject: 'PENDING UPDATION',
            html: messageHtml
          });
          console.log(`Sent weekly report to ${ compData.company_name } `);
        } catch (err) {
          console.error(`Error sending weekly report to ${ compData.company_name }: `, err);
        }
      }
    } catch (err) {
      console.error('Error in weekly consolidated job:', err);
    }
  });
}

module.exports = { initCronJobs };

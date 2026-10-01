const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');

function initCronJobs() {
  // Run every day at 8:00 AM
  cron.schedule('0 8 * * *', async () => {
    // cron.schedule('* * * * *', async () => {
    console.log('Running daily follow-up reminders job...');
    try {
      // 1. Find POs that have incomplete stages where scheduled date has passed
      // We will group by PO so we only send 1 email per PO, listing the delayed stages.
      const [delayedStages] = await pool.query(`
        SELECT 
          po.id as po_id, po.po_number, po.factory_email, po.company_id,
          ps.stage_name, 
          pws.scheduled_end_date 
        FROM purchase_orders po
        JOIN po_workflow_schedules pws ON po.id = pws.po_id
        JOIN production_stages ps ON pws.stage_id = ps.id
        WHERE po.status != 'completed' AND po.status != 'cancelled'
        AND pws.actual_end_date IS NULL
        AND pws.scheduled_end_date < CURRENT_DATE()
      `);

      if (delayedStages.length === 0) {
        console.log('No delayed stages found today.');
        return;
      }

      // Group by PO
      const poGroups = {};
      delayedStages.forEach(row => {
        if (!row.factory_email) return; // Skip if no factory email
        if (!poGroups[row.po_id]) {
          poGroups[row.po_id] = {
            company_id: row.company_id,
            po_number: row.po_number,
            factory_email: row.factory_email,
            delayed_stages: []
          };
        }
        poGroups[row.po_id].delayed_stages.push({
          stage_name: row.stage_name,
          scheduled_end_date: row.scheduled_end_date
        });
      });

      // Send 1 email per PO
      for (const poId in poGroups) {
        const poData = poGroups[poId];

        let stagesHtml = '<ul>';
        poData.delayed_stages.forEach(stage => {
          const dateStr = new Date(stage.scheduled_end_date).toLocaleDateString();
          stagesHtml += `<li><strong style="color:red;">${stage.stage_name}</strong> was scheduled to be completed by <strong>${dateStr}</strong>.</li>`;
        });
        stagesHtml += '</ul>';

        const reminderMessage = `
          <p>Hello,</p>
          <p>This is an urgent daily alert regarding <b>PO #${poData.po_number}</b>.</p>
          <p>The following production stages are currently incomplete and have passed their scheduled deadlines:</p>
          ${stagesHtml}
          <p>Please update the system with the actual completion dates or provide a status update immediately.</p>
          <br/>
          <p>Thank you.</p>
        `;

        try {
          await sendEmail({
            companyId: poData.company_id,
            to: poData.factory_email,
            subject: `URGENT: Delayed Production Stages - PO #${poData.po_number}`,
            html: reminderMessage
          });
          console.log(`Sent stage delay reminder for PO ${poData.po_number}`);
        } catch (err) {
          console.error(`Failed to send reminder for PO ${poData.po_number}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Error running cron job:', err);
    }
  });



  // Run at 4:25 PM every Tuesday (for testing)
  cron.schedule('55 16 * * 2', async () => {
    console.log('Running weekly PO delivery date check job...');
    try {
      // Find POs without delivery date and join with companies table to get company email
      const [missingDeliveryDatePOs] = await pool.query(`
        SELECT po.po_number, po.created_at, po.company_id, c.email as company_email, c.company_name
        FROM purchase_orders po
        JOIN companies c ON po.company_id = c.company_id
        WHERE po.po_delivery_date IS NULL OR po.po_delivery_date = '' OR po.po_delivery_date = '0000-00-00 00:00:00'
      `);

      if (missingDeliveryDatePOs.length === 0) {
        console.log('No POs missing delivery dates found this week.');
        return;
      }

      // Group POs by company
      const companyGroups = {};
      missingDeliveryDatePOs.forEach(po => {
        if (!po.company_email) return;
        if (!companyGroups[po.company_id]) {
          companyGroups[po.company_id] = {
            company_email: po.company_email,
            company_name: po.company_name,
            pos: []
          };
        }
        companyGroups[po.company_id].pos.push(po);
      });

      // Send 1 email per company
      for (const compId in companyGroups) {
        const compData = companyGroups[compId];
        let poListHtml = '<ul>';
        compData.pos.forEach(po => {
          poListHtml += `<li><strong>PO #${po.po_number}</strong> (Created: ${new Date(po.created_at).toLocaleDateString()})</li>`;
        });
        poListHtml += '</ul>';

        // const messageHtml = `
        //   <p>Hello ${compData.company_name} Team,</p>
        //   <p>This is a weekly alert. The following Purchase Orders are missing a Delivery Date. Because of this, their OFC (Order Follow-up Chart) cannot be generated:</p>
        //   ${poListHtml}
        //   <p>Please update these POs in the system.</p>
        //   <br/>
        //   <p>Thank you.</p>
        // `;


        const messageHtml = `
  <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 700px; margin: 0 auto;">

    <div style="background: #f5f7fa; padding: 20px 24px; border-bottom: 3px solid #2f5bea;">
      <h2 style="margin: 0; color: #1f2937; font-size: 20px;">
        Weekly OFC Alert
      </h2>
      <p style="margin: 6px 0 0; color: #6b7280; font-size: 13px;">
        Purchase Orders with Missing Delivery Dates
      </p>
    </div>

    <div style="padding: 24px;">
      <p style="margin-top: 0;">
        Hello <strong>${compData.company_name} Team</strong>,
      </p>

      <p>
        This is your weekly OFC (Order Follow-up Chart) alert.
        The following Purchase Orders are currently missing a
        <strong>Delivery Date</strong>.
      </p>

      <div style="background: #fff7ed; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 20px 0;">
        <strong style="color: #92400e;">Action Required</strong>
        <p style="margin: 5px 0 0; color: #78350f;">
          Please update the Delivery Date for these POs in the system.
          OFC cannot be generated until the Delivery Date is available.
        </p>
      </div>

      ${poListHtml}

      <p style="margin-top: 24px;">
        Once the Delivery Dates are updated, the OFC can be generated normally.
      </p>

      <p style="margin-bottom: 0;">
        Thank you.
      </p>

      <p style="margin-top: 20px; color: #6b7280; font-size: 12px;">
        This is an automated weekly notification. Please do not reply to this email.
      </p>
    </div>

  </div>`




        try {
          await sendEmail({
            companyId: compId,
            to: compData.company_email,
            subject: 'PENDING UPDATION',
            html: messageHtml
          });
          console.log(`Sent weekly PO delivery date missing alert to company ${compData.company_name} (${compData.company_email}).`);
        } catch (err) {
          console.error(`Error sending weekly PO alert to ${compData.company_name}:`, err);
        }
      }
    } catch (err) {
      console.error('Error running weekly PO check job:', err);
    }
  });
}

module.exports = { initCronJobs };

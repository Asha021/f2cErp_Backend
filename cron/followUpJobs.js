const cron = require('node-cron');
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');

// Stage definitions based on days from creation vs delivery
// 1. Pending (created recently)
// 2. Processing (in middle of timeline)
// 3. Shipped (nearing delivery date)
// 4. Overdue (past delivery date)

function initCronJobs() {
  // Run every day at 8:00 AM
  cron.schedule('0 8 * * *', async () => {
    console.log('Running daily follow-up reminders job...');
    try {
      const [pos] = await pool.query(
        `SELECT po.*, c.smtp_email 
         FROM purchase_orders po
         JOIN companies c ON po.company_id = c.company_id
         WHERE po.status != 'completed' AND po.status != 'cancelled'`
      );

      const now = new Date();

      for (const po of pos) {
        if (!po.po_delivery_date || !po.factory_email) continue;
        
        const deliveryDate = new Date(po.po_delivery_date);
        const daysUntilDelivery = Math.ceil((deliveryDate - now) / (1000 * 60 * 60 * 24));

        let sendReminder = false;
        let reminderMessage = '';

        // Example Basic Logic for 4-stages:
        if (daysUntilDelivery < 0) {
          // Overdue
          sendReminder = true;
          reminderMessage = `This is an urgent reminder that PO #${po.po_number} is OVERDUE for delivery by ${Math.abs(daysUntilDelivery)} days.`;
        } else if (daysUntilDelivery === 3) {
          // Stage 3: Shipped / Nearing delivery
          sendReminder = true;
          reminderMessage = `This is a reminder that PO #${po.po_number} is due for delivery in 3 days on ${deliveryDate.toLocaleDateString()}. Please confirm shipping status.`;
        }

        if (sendReminder) {
          try {
            await sendEmail({
              companyId: po.company_id,
              to: po.factory_email,
              subject: `Follow-up Reminder - PO #${po.po_number}`,
              html: `<p>Hello,</p><p>${reminderMessage}</p><p>Please respond with a status update.</p><br/><p>Thank you.</p>`
            });
            console.log(`Sent reminder for PO ${po.po_number}`);
          } catch (err) {
            console.error(`Failed to send reminder for PO ${po.po_number}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('Error running cron job:', err);
    }
  });
}

module.exports = { initCronJobs };

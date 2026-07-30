const pool = require('./config/db');
const { sendEmail } = require('./utils/mailer');

async function runTestCron() {
  console.log('--- Running Manual Follow-up Reminders Job ---');
  try {
    const [pos] = await pool.query(
      `SELECT po.*, c.smtp_email 
       FROM purchase_orders po
       JOIN companies c ON po.company_id = c.company_id
       WHERE po.status != 'completed' AND po.status != 'cancelled'`
    );

    const now = new Date();
    let sentCount = 0;

    for (const po of pos) {
      if (!po.po_delivery_date || !po.factory_email) continue;
      
      const deliveryDate = new Date(po.po_delivery_date);
      const daysUntilDelivery = Math.ceil((deliveryDate - now) / (1000 * 60 * 60 * 24));

      let sendReminder = false;
      let reminderMessage = '';

      if (daysUntilDelivery < 0) {
        sendReminder = true;
        reminderMessage = `This is an urgent reminder that PO #${po.po_number} is OVERDUE for delivery by ${Math.abs(daysUntilDelivery)} days.`;
        console.log(`[PO #${po.po_number}] is Overdue by ${Math.abs(daysUntilDelivery)} days. Preparing email...`);
      } else if (daysUntilDelivery === 3) {
        sendReminder = true;
        reminderMessage = `This is a reminder that PO #${po.po_number} is due for delivery in 3 days on ${deliveryDate.toLocaleDateString()}. Please confirm shipping status.`;
        console.log(`[PO #${po.po_number}] is due in 3 days. Preparing email...`);
      }

      if (sendReminder) {
        try {
          await sendEmail({
            companyId: po.company_id,
            to: po.factory_email,
            subject: `Follow-up Reminder - PO #${po.po_number}`,
            html: `<p>Hello,</p><p>${reminderMessage}</p><p>Please respond with a status update.</p><br/><p>Thank you.</p>`
          });
          console.log(`✅ Sent reminder email to ${po.factory_email} for PO ${po.po_number}`);
          sentCount++;
        } catch (err) {
          console.error(`❌ Failed to send reminder to ${po.factory_email} for PO ${po.po_number}:`, err.message);
        }
      }
    }
    
    if (sentCount === 0) {
      console.log('No reminders were needed at this time.');
    } else {
      console.log(`\nDone! Successfully sent ${sentCount} reminders.`);
    }
  } catch (err) {
    console.error('Error running test cron job:', err);
  } finally {
    process.exit(0);
  }
}

runTestCron();

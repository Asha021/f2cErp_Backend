const pool = require('./config/db');

async function test() {
  try {
    console.log("DESCRIBE po_workflow_schedules:");
    const [cols] = await pool.query('DESCRIBE po_workflow_schedules');
    console.log(cols);

    console.log("DESCRIBE workflow_audit_logs:");
    const [cols2] = await pool.query('DESCRIBE workflow_audit_logs');
    console.log(cols2);

    console.log("DESCRIBE po_shipments:");
    const [cols3] = await pool.query('DESCRIBE po_shipments');
    console.log(cols3);

    process.exit(0);
  } catch (err) {
    console.error("FAILED:", err);
    process.exit(1);
  }
}

test();

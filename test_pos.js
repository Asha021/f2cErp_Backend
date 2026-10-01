const pool = require('./config/db');
async function testQuery() {
  const [pos] = await pool.query('SELECT po_number, company_id, created_at FROM purchase_orders WHERE po_delivery_date IS NULL OR po_delivery_date = "" OR po_delivery_date = "0000-00-00 00:00:00"');
  console.log(pos.slice(0, 5));
  process.exit(0);
}
testQuery();

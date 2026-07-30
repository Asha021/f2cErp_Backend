const pool = require('./config/db');

pool.query(`
  SELECT po.id, po.po_number, po.po_date, po.factory, po.status,
          SUM(pi.quantity * pi.price) AS total_amount
   FROM purchase_orders po
   LEFT JOIN po_items pi ON po.id = pi.po_id
   WHERE po.company_id = ?
   GROUP BY po.id
   ORDER BY po.created_at DESC
`, [2])
.then(([rows]) => {
  console.log('Success, rows:', rows.length);
  process.exit(0);
})
.catch(err => {
  console.error('Error executing query:', err.message);
  process.exit(1);
});

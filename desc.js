const pool = require('./config/db');
(async () => {
  try {
    const [rows] = await pool.query('DESCRIBE purchase_orders');
    console.log(rows);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

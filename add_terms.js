const pool = require('./config/db');
(async () => {
  try {
    await pool.query('ALTER TABLE purchase_orders ADD COLUMN terms VARCHAR(255) DEFAULT NULL');
    console.log("Added terms column.");
    process.exit(0);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log("Column terms already exists.");
      process.exit(0);
    } else {
      console.error(err);
      process.exit(1);
    }
  }
})();

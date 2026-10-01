const pool = require('./config/db');
async function run() {
  const [cols] = await pool.query('SHOW COLUMNS FROM companies');
  console.log(cols.map(c => c.Field));
  process.exit(0);
}
run();

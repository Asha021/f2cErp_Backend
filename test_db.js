const pool = require('./config/db');
async function run() {
  const [users] = await pool.query('SELECT * FROM users WHERE role = "superadmin" OR role = "super_admin" OR role = "admin"');
  console.log(users);
  process.exit(0);
}
run();

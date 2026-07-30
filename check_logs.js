const pool = require('./config/db');
(async () => {
    const [rows] = await pool.query('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 2');
    console.log(rows);
    process.exit();
})();

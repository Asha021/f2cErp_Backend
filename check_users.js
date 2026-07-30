const mysql = require('mysql2/promise');

async function test() {
    try {
        const pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'uaconsu1_f2cerp'
        });
        
        const [users] = await pool.query('SELECT id, email, role, company_id FROM users');
        console.log(users);
        process.exit(0);
    } catch(err) {
        console.error(err.message);
        process.exit(1);
    }
}
test();

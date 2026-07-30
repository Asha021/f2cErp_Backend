const mysql = require('mysql2/promise');

async function test() {
    try {
        const pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'uaconsu1_f2cerp'
        });
        
        const [stages] = await pool.query(
            'SELECT id, stage_name as name, order_index, is_enabled, color, allocation_type, allocation_value, dependencies FROM production_stages'
        );
        console.log(stages);
        process.exit(0);
    } catch(err) {
        console.error(err.message);
        process.exit(1);
    }
}
test();

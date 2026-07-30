const mysql = require('mysql2/promise');

async function test() {
    try {
        const pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'uaconsu1_f2cerp'
        });
        
        const [pos] = await pool.query('SELECT id, po_number, po_date, po_delivery_date FROM purchase_orders');
        console.log("POs:", pos);
        
        const [schedules] = await pool.query('SELECT * FROM po_workflow_schedules');
        console.log("Schedules:", schedules);
        process.exit(0);
    } catch(err) {
        console.error(err.message);
        process.exit(1);
    }
}
test();

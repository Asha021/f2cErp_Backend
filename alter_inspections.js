const mysql = require('mysql2/promise');
(async () => {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'uaconsu1_inspectapp'
    });
    try {
        await conn.query('ALTER TABLE inspections ADD COLUMN erp_po_id INT NULL, ADD COLUMN erp_item_id INT NULL');
        console.log("Columns added successfully");
    } catch(e) {
        console.log("Error or already exists:", e.message);
    }
    process.exit();
})();

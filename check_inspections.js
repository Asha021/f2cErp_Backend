const mysql = require('mysql2/promise');
(async () => {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'uaconsu1_inspectapp'
    });
    const [rows] = await conn.query('DESCRIBE inspections');
    console.log(rows);
    process.exit();
})();

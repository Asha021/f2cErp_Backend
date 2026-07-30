const mysql = require('mysql2/promise');

async function checkAndCreate() {
    try {
        const pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'uaconsu1_f2cerp'
        });
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS workflow_audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                company_id INT NOT NULL,
                po_id INT NOT NULL,
                action VARCHAR(50) NOT NULL,
                description TEXT,
                changed_by INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Audit log table created or already exists.");
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
checkAndCreate();

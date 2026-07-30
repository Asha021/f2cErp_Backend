const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'uaconsu1_f2cerp',
    });

    try {
        console.log("Starting Migration...");
        
        await pool.query(`
        CREATE TABLE IF NOT EXISTS workflow_templates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            company_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY(company_id)
        )`);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS workflow_template_versions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            template_id INT NOT NULL,
            version_number INT NOT NULL,
            is_active BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (template_id) REFERENCES workflow_templates(id) ON DELETE CASCADE
        )`);

        const addCol = async (table, col, def) => {
            try {
                await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
                console.log(`Added column ${col} to ${table}`);
            } catch (e) {
                if (e.code === 'ER_DUP_FIELDNAME') {
                    console.log(`Column ${col} already exists on ${table}.`);
                } else {
                    throw e;
                }
            }
        };

        await addCol('production_stages', 'template_version_id', 'INT DEFAULT NULL');
        await addCol('production_stages', 'is_enabled', 'BOOLEAN DEFAULT TRUE');
        await addCol('production_stages', 'color', "VARCHAR(7) DEFAULT '#4F46E5'");
        await addCol('production_stages', 'allocation_type', "ENUM('equal', 'percentage', 'manual') DEFAULT 'equal'");
        await addCol('production_stages', 'allocation_value', 'DECIMAL(5,2) DEFAULT NULL');
        await addCol('production_stages', 'dependencies', 'JSON');

        await pool.query(`
        CREATE TABLE IF NOT EXISTS holiday_calendars (
            id INT AUTO_INCREMENT PRIMARY KEY,
            company_id INT NOT NULL,
            holiday_date DATE NOT NULL,
            description VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY(company_id)
        )`);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS working_days (
            id INT AUTO_INCREMENT PRIMARY KEY,
            company_id INT NOT NULL,
            day_of_week INT NOT NULL,
            is_working BOOLEAN DEFAULT TRUE,
            UNIQUE KEY (company_id, day_of_week)
        )`);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS workflow_audit_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            company_id INT NOT NULL,
            po_id INT,
            action VARCHAR(50) NOT NULL,
            description TEXT,
            changed_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY(company_id),
            KEY(po_id)
        )`);

        try {
            // Drop enum safely by changing to varchar
            await pool.query("ALTER TABLE po_workflow_schedules MODIFY status VARCHAR(50) DEFAULT 'pending'");
        } catch (e) {
            console.log("Status modify error (safe to ignore if already varchar):", e.message);
        }

        // Seed
        await pool.query(`
            INSERT INTO workflow_templates (company_id, name, description)
            SELECT 1, 'Legacy V1 Template', 'Automatically generated legacy template'
            WHERE NOT EXISTS (SELECT 1 FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template')
        `);

        await pool.query(`
            INSERT INTO workflow_template_versions (template_id, version_number, is_active)
            SELECT (SELECT id FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template' LIMIT 1), 1, TRUE
            WHERE NOT EXISTS (SELECT 1 FROM workflow_template_versions WHERE template_id = (SELECT id FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template' LIMIT 1))
        `);

        await pool.query(`
            UPDATE production_stages 
            SET template_version_id = (SELECT id FROM workflow_template_versions WHERE template_id = (SELECT id FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template' LIMIT 1) LIMIT 1)
            WHERE template_version_id IS NULL
        `);

        await pool.query(`
            INSERT IGNORE INTO working_days (company_id, day_of_week, is_working) VALUES 
            (1, 0, FALSE), (1, 1, TRUE), (1, 2, TRUE), (1, 3, TRUE), 
            (1, 4, TRUE), (1, 5, TRUE), (1, 6, FALSE)
        `);

        console.log("Migration Completed Successfully!");
        process.exit(0);
    } catch (err) {
        console.error("Migration Failed:", err);
        process.exit(1);
    }
}

runMigration();

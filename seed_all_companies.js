const mysql = require('mysql2/promise');

async function run() {
    try {
        const pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'uaconsu1_f2cerp'
        });
        
        const [companies] = await pool.query('SELECT DISTINCT company_id FROM users WHERE company_id IS NOT NULL');
        
        for (let comp of companies) {
            const cid = comp.company_id;
            
            // Ensure template exists
            const [activeVersions] = await pool.query(`
                SELECT v.id FROM workflow_template_versions v
                JOIN workflow_templates t ON v.template_id = t.id
                WHERE t.company_id = ? AND v.is_active = TRUE LIMIT 1
            `, [cid]);
            
            let version_id;
            if (activeVersions.length === 0) {
                const [tempRes] = await pool.query(
                    'INSERT INTO workflow_templates (company_id, name, description) VALUES (?, ?, ?)',
                    [cid, 'Default Template', 'Automatically generated template']
                );
                const [verRes] = await pool.query(
                    'INSERT INTO workflow_template_versions (template_id, version_number, is_active) VALUES (?, ?, ?)',
                    [tempRes.insertId, 1, true]
                );
                version_id = verRes.insertId;
            } else {
                version_id = activeVersions[0].id;
            }
            
            // Check if they have stages
            const [stagesExist] = await pool.query('SELECT id FROM production_stages WHERE company_id = ?', [cid]);
            
            if (stagesExist.length === 0) {
                console.log(`Inserting default stages for company ${cid}...`);
                const stages = ['Raw Material', 'Fabrication', 'Polishing', 'Packing'];
                for (let i = 0; i < stages.length; i++) {
                    await pool.query(
                        'INSERT INTO production_stages (company_id, template_version_id, stage_name, order_index, is_enabled, color) VALUES (?, ?, ?, ?, ?, ?)',
                        [cid, version_id, stages[i], i + 1, true, '#4F46E5']
                    );
                }
            }
        }
        
        console.log('Done ensuring all companies have templates and stages.');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
run();

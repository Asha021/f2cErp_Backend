const mysql = require('mysql2/promise');
const { distributeDates } = require('./utils/workflowUtils');

async function fix() {
    try {
        const pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'uaconsu1_f2cerp'
        });
        
        const [pos] = await pool.query('SELECT * FROM purchase_orders WHERE po_delivery_date > "2000-01-01"');
        
        for (const po of pos) {
            await pool.query('DELETE FROM po_workflow_schedules WHERE po_id = ?', [po.id]);
            console.log(`Fixing PO ${po.po_number}...`);
            const [allStages] = await pool.query('SELECT * FROM production_stages WHERE company_id = ? ORDER BY order_index ASC', [po.company_id]);
            if (allStages.length > 0) {
                const dates = distributeDates(po.po_date, po.po_delivery_date, allStages);
                for (let i = 0; i < allStages.length; i++) {
                    await pool.query(
                        'INSERT INTO po_workflow_schedules (po_id, stage_id, scheduled_start_date, scheduled_end_date) VALUES (?, ?, ?, ?)',
                        [po.id, allStages[i].id, dates[i].start, dates[i].end]
                    );
                }
                console.log(`Generated OFC for PO ${po.po_number}`);
            }
        }
        
        console.log('Done!');
        process.exit(0);
    } catch(err) {
        console.error(err.message);
        process.exit(1);
    }
}
fix();

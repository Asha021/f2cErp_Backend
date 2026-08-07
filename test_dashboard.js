const mysql = require('mysql2/promise');
async function test() {
  const c = await mysql.createConnection({host:'localhost',user:'root',database:'uaconsu1_f2cerp'});
  const [stages] = await c.query('SELECT id, stage_name FROM production_stages WHERE company_id = 4 ORDER BY order_index ASC LIMIT 10');
  console.log('Stages:', stages);

  const [pos] = await c.query(`
      SELECT 
        po.id, po.po_number, po.factory, po.po_date, po.po_delivery_date,
        (
          SELECT ps.stage_id
          FROM po_workflow_schedules ps
          JOIN production_stages stg ON ps.stage_id = stg.id
          WHERE ps.po_id = po.id AND ps.status NOT IN ('completed', 'cancelled')
          ORDER BY stg.order_index ASC
          LIMIT 1
        ) as current_stage_id
      FROM purchase_orders po
      WHERE po.company_id = 4 AND po.status != 'completed'
  `);
  console.log('POs:', pos);
  process.exit();
}
test();

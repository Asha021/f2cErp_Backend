const pool = require('./config/db');
const { generateInvoiceDocx } = require('./utils/documentGenerator');

async function test() {
  try {
    console.log("Fetching any available sale details...");
    const [saleRows] = await pool.query('SELECT * FROM sales LIMIT 1');
    if (saleRows.length === 0) {
      console.log("No sales found in database.");
      process.exit(0);
    }
    const sale = saleRows[0];
    console.log("Sale details:", sale);

    console.log("Fetching sale items...");
    const [items] = await pool.query(
      `SELECT si.sale_item_id, si.item_id, si.quantity, si.unit_price, si.total_price, i.item_name
       FROM sale_items si LEFT JOIN items i ON si.item_id = i.item_id
       WHERE si.sale_id = ?`,
      [sale.sale_id]
    );
    console.log("Items count:", items.length);

    console.log("Fetching company...");
    const [compRows] = await pool.query('SELECT * FROM companies WHERE company_id = ?', [sale.company_id]);
    const company = compRows[0] || {};
    console.log("Company:", company);

    console.log("Generating DOCX invoice...");
    const buffer = await generateInvoiceDocx(sale, items, company);
    console.log("Generated successfully! Buffer size:", buffer.length);
    process.exit(0);
  } catch (err) {
    console.error("GENERATION ERROR:", err);
    process.exit(1);
  }
}

test();

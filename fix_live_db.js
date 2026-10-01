const pool = require('./config/db');

async function checkAndAddColumn(table, column, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[Success] Added column '${column}' to table '${table}'.`);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log(`[Skip] Column '${column}' already exists in table '${table}'.`);
    } else {
      console.error(`[Error] Failed to add '${column}' to '${table}':`, err.message);
    }
  }
}

(async () => {
  console.log("Starting Live DB schema update...");

  // purchase_orders table updates
  await checkAndAddColumn('purchase_orders', 'terms', 'VARCHAR(255) DEFAULT NULL');
  await checkAndAddColumn('purchase_orders', 'special_comments', 'TEXT DEFAULT NULL');
  await checkAndAddColumn('purchase_orders', 'revision_no', 'INT DEFAULT 0');

  // po_items table updates
  await checkAndAddColumn('po_items', 'currency', 'VARCHAR(10) DEFAULT "USD"');
  await checkAndAddColumn('po_items', 'size', 'VARCHAR(255) DEFAULT NULL');
  await checkAndAddColumn('po_items', 'eft', 'VARCHAR(255) DEFAULT NULL');
  await checkAndAddColumn('po_items', 'finish', 'VARCHAR(255) DEFAULT NULL');
  await checkAndAddColumn('po_items', 'special_comments', 'TEXT DEFAULT NULL');
  await checkAndAddColumn('po_items', 'inspection_status', 'VARCHAR(50) DEFAULT "pending"');
  await checkAndAddColumn('po_items', 'ppt_source_url', 'VARCHAR(1000) DEFAULT NULL');
  await checkAndAddColumn('po_items', 'ppt_backup_path', 'VARCHAR(1000) DEFAULT NULL');
  
  await checkAndAddColumn('po_items', 'length', 'DECIMAL(10,2) DEFAULT NULL');
  await checkAndAddColumn('po_items', 'width', 'DECIMAL(10,2) DEFAULT NULL');
  await checkAndAddColumn('po_items', 'height', 'DECIMAL(10,2) DEFAULT NULL');

  console.log("Database schema update finished!");
  process.exit(0);
})();

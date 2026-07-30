require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  try {
    console.log("Creating production_stages table...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS production_stages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        company_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        order_index INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE
      )
    `);

    console.log("Creating po_workflow_schedules table...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS po_workflow_schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        po_id INT NOT NULL,
        stage_id INT NOT NULL,
        status ENUM('pending', 'in_progress', 'completed') DEFAULT 'pending',
        scheduled_start_date DATE,
        scheduled_end_date DATE,
        actual_start_date DATE,
        actual_end_date DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
        FOREIGN KEY (stage_id) REFERENCES production_stages(id) ON DELETE CASCADE
      )
    `);

    // Let's also check if any companies exist and insert default stages if they don't have any
    const [companies] = await pool.query('SELECT company_id FROM companies');
    for (const company of companies) {
      const [existingStages] = await pool.query('SELECT COUNT(*) as count FROM production_stages WHERE company_id = ?', [company.company_id]);
      if (existingStages[0].count === 0) {
        console.log(`Inserting default stages for company ${company.company_id}...`);
        await pool.query(`
          INSERT INTO production_stages (company_id, name, order_index) VALUES
          (?, 'Raw Material', 1),
          (?, 'Fabrication', 2),
          (?, 'Polishing', 3),
          (?, 'Packing', 4)
        `, [
          company.company_id, company.company_id, company.company_id, company.company_id
        ]);
      }
    }

    console.log("Done!");
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

run();

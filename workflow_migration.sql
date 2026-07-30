USE uaconsu1_f2cerp;

CREATE TABLE IF NOT EXISTS production_stages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    stage_name VARCHAR(100) NOT NULL,
    order_index INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY(company_id)
);

CREATE TABLE IF NOT EXISTS po_workflow_schedules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    po_id INT NOT NULL,
    stage_id INT NOT NULL,
    scheduled_start_date DATE,
    scheduled_end_date DATE,
    actual_start_date DATE,
    actual_end_date DATE,
    status ENUM('pending', 'in_progress', 'completed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY(po_id),
    KEY(stage_id)
);

-- Seed default data for company_id = 1 if none exists
INSERT INTO production_stages (company_id, stage_name, order_index)
SELECT 1, 'Raw Material', 1
WHERE NOT EXISTS (SELECT 1 FROM production_stages WHERE company_id = 1 AND order_index = 1);

INSERT INTO production_stages (company_id, stage_name, order_index)
SELECT 1, 'Fabrication', 2
WHERE NOT EXISTS (SELECT 1 FROM production_stages WHERE company_id = 1 AND order_index = 2);

INSERT INTO production_stages (company_id, stage_name, order_index)
SELECT 1, 'Polishing', 3
WHERE NOT EXISTS (SELECT 1 FROM production_stages WHERE company_id = 1 AND order_index = 3);

INSERT INTO production_stages (company_id, stage_name, order_index)
SELECT 1, 'Packing', 4
WHERE NOT EXISTS (SELECT 1 FROM production_stages WHERE company_id = 1 AND order_index = 4);

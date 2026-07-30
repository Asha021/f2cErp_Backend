USE uaconsu1_f2cerp;

-- 1. Workflow Templates
CREATE TABLE IF NOT EXISTS workflow_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY(company_id)
);

-- 2. Workflow Template Versions
CREATE TABLE IF NOT EXISTS workflow_template_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    template_id INT NOT NULL,
    version_number INT NOT NULL,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (template_id) REFERENCES workflow_templates(id) ON DELETE CASCADE
);

-- 3. Modify production_stages to link to template_versions and add new fields
-- First, add columns safely using a procedure since MySQL doesn't support IF NOT EXISTS in ALTER TABLE
DELIMITER //
CREATE PROCEDURE AddColumnsToProductionStages()
BEGIN
    IF NOT EXISTS(SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='uaconsu1_f2cerp' AND TABLE_NAME='production_stages' AND COLUMN_NAME='template_version_id') THEN
        ALTER TABLE production_stages ADD COLUMN template_version_id INT DEFAULT NULL;
    END IF;
    IF NOT EXISTS(SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='uaconsu1_f2cerp' AND TABLE_NAME='production_stages' AND COLUMN_NAME='is_enabled') THEN
        ALTER TABLE production_stages ADD COLUMN is_enabled BOOLEAN DEFAULT TRUE;
    END IF;
    IF NOT EXISTS(SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='uaconsu1_f2cerp' AND TABLE_NAME='production_stages' AND COLUMN_NAME='color') THEN
        ALTER TABLE production_stages ADD COLUMN color VARCHAR(7) DEFAULT '#4F46E5';
    END IF;
    IF NOT EXISTS(SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='uaconsu1_f2cerp' AND TABLE_NAME='production_stages' AND COLUMN_NAME='allocation_type') THEN
        ALTER TABLE production_stages ADD COLUMN allocation_type ENUM('equal', 'percentage', 'manual') DEFAULT 'equal';
    END IF;
    IF NOT EXISTS(SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='uaconsu1_f2cerp' AND TABLE_NAME='production_stages' AND COLUMN_NAME='allocation_value') THEN
        ALTER TABLE production_stages ADD COLUMN allocation_value DECIMAL(5,2) DEFAULT NULL;
    END IF;
    IF NOT EXISTS(SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='uaconsu1_f2cerp' AND TABLE_NAME='production_stages' AND COLUMN_NAME='dependencies') THEN
        ALTER TABLE production_stages ADD COLUMN dependencies JSON;
    END IF;
END //
DELIMITER ;
CALL AddColumnsToProductionStages();
DROP PROCEDURE AddColumnsToProductionStages;

-- 4. Calendars and Working Days
CREATE TABLE IF NOT EXISTS holiday_calendars (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    holiday_date DATE NOT NULL,
    description VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY(company_id)
);

CREATE TABLE IF NOT EXISTS working_days (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    day_of_week INT NOT NULL, -- 0=Sun, 1=Mon, ..., 6=Sat
    is_working BOOLEAN DEFAULT TRUE,
    UNIQUE KEY (company_id, day_of_week)
);

-- 5. Audit Logs
CREATE TABLE IF NOT EXISTS workflow_audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    po_id INT,
    action VARCHAR(50) NOT NULL,
    description TEXT,
    changed_by INT, -- User ID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY(company_id),
    KEY(po_id)
);

-- 6. Update po_workflow_schedules status Enum using a safer VARCHAR approach to avoid tight coupling
DELIMITER //
CREATE PROCEDURE UpdatePOWorkflowSchedulesStatus()
BEGIN
    IF EXISTS(SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='uaconsu1_f2cerp' AND TABLE_NAME='po_workflow_schedules' AND COLUMN_NAME='status' AND COLUMN_TYPE LIKE 'enum%') THEN
        ALTER TABLE po_workflow_schedules MODIFY status VARCHAR(50) DEFAULT 'pending';
    END IF;
END //
DELIMITER ;
CALL UpdatePOWorkflowSchedulesStatus();
DROP PROCEDURE UpdatePOWorkflowSchedulesStatus;

-- 7. Seed Legacy Template for backward compatibility
-- Insert a default template if none exist
INSERT INTO workflow_templates (company_id, name, description)
SELECT 1, 'Legacy V1 Template', 'Automatically generated legacy template'
WHERE NOT EXISTS (SELECT 1 FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template');

-- Insert version 1 for the legacy template
INSERT INTO workflow_template_versions (template_id, version_number, is_active)
SELECT (SELECT id FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template' LIMIT 1), 1, TRUE
WHERE NOT EXISTS (SELECT 1 FROM workflow_template_versions WHERE template_id = (SELECT id FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template' LIMIT 1));

-- Link existing production stages to this legacy version
UPDATE production_stages 
SET template_version_id = (SELECT id FROM workflow_template_versions WHERE template_id = (SELECT id FROM workflow_templates WHERE company_id = 1 AND name = 'Legacy V1 Template' LIMIT 1) LIMIT 1)
WHERE template_version_id IS NULL;

-- Default Working Days (Mon-Fri) for company 1
INSERT IGNORE INTO working_days (company_id, day_of_week, is_working) VALUES 
(1, 0, FALSE), (1, 1, TRUE), (1, 2, TRUE), (1, 3, TRUE), 
(1, 4, TRUE), (1, 5, TRUE), (1, 6, FALSE);

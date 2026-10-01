USE uaconsu1_inspectapp;
CREATE TABLE IF NOT EXISTS inspection_assignments (
    assignment_id VARCHAR(36) PRIMARY KEY,
    inspection_id VARCHAR(36) NOT NULL,
    inspector_id VARCHAR(64) NOT NULL,
    status ENUM('Pending', 'In Progress', 'Completed', 'Released', 'Removed') DEFAULT 'Pending',
    assigned_by VARCHAR(64),
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX (inspection_id),
    INDEX (inspector_id)
);
ALTER TABLE inspections
ADD COLUMN IF NOT EXISTS locked_by VARCHAR(64) NULL AFTER inspector_id,
ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP NULL AFTER locked_by;
CREATE TABLE IF NOT EXISTS inspection_activity_log (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    inspection_id VARCHAR(36) NOT NULL,
    inspector_id VARCHAR(64) NOT NULL,
    action ENUM('Assigned', 'Lock Acquired', 'Draft Saved', 'Handover', 'Lock Released', 'Completed', 'Removed') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX (inspection_id),
    INDEX (inspector_id)
);

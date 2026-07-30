ALTER TABLE `purchase_orders`
ADD COLUMN `sync_status` ENUM('Not Synced', 'Synced', 'Sync Failed') DEFAULT 'Not Synced';

CREATE TABLE IF NOT EXISTS `sync_logs` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `erp_po_id` INT NOT NULL,
    `status` ENUM('Synced', 'Sync Failed') NOT NULL,
    `synced_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `response` TEXT,
    `error` TEXT,
    FOREIGN KEY (`erp_po_id`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

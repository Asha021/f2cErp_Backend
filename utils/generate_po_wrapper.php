<?php
error_reporting(E_ERROR | E_PARSE);
require_once __DIR__ . '/vendor/autoload.php';

$json = file_get_contents('php://stdin');
$data = json_decode($json, true);

if (!$data) {
    echo "ERROR: Invalid JSON data";
    exit(1);
}

$po = $data['po'];
$items = $data['items'];
$templatePath = __DIR__ . '/../templates/po_template_clean.docx';
$outputPath = __DIR__ . '/temp_po_' . uniqid() . '.docx';

try {
    $templateProcessor = new \PhpOffice\PhpWord\TemplateProcessor($templatePath);
    
    // Set PO scalar values exactly as in the original code
    $templateProcessor->setValue('po_number', htmlspecialchars($po['po_number'] ?? '', ENT_XML1));
    $templateProcessor->setValue('po_date', date('d/m/Y', strtotime($po['po_date'])));
    $templateProcessor->setValue('buyer', htmlspecialchars($po['buyer'] ?? '', ENT_XML1));
    $templateProcessor->setValue('buyer_address', htmlspecialchars($po['buyer_address'] ?? '', ENT_XML1));
    $templateProcessor->setValue('factory', htmlspecialchars($po['factory'] ?? '', ENT_XML1));
    $templateProcessor->setValue('factory_email', htmlspecialchars($po['factory_email'] ?? '', ENT_XML1));
    $templateProcessor->setValue('factory_address', htmlspecialchars($po['factory_address'] ?? '', ENT_XML1));
    $templateProcessor->setValue('delivery_date', date('d/m/Y', strtotime($po['po_delivery_date'])));
    $templateProcessor->setValue('special_comments', htmlspecialchars($po['special_comments'] ?? '', ENT_XML1));
    
    // Process items
    if (count($items) > 0) {
        $templateProcessor->cloneRow('item_no', count($items));
        $i = 1;
        foreach ($items as $item) {
            $templateProcessor->setValue('item_no#' . $i, htmlspecialchars($item['item_no'] ?? '', ENT_XML1));
            $templateProcessor->setValue('serial_number#' . $i, htmlspecialchars($item['serial_number'] ?? '', ENT_XML1));
            $desc = !empty($item['description']) ? $item['description'] : ($item['item_name'] ?? '');
            $templateProcessor->setValue('description#' . $i, htmlspecialchars($desc, ENT_XML1));
            $templateProcessor->setValue('quantity#' . $i, intval($item['quantity']));
            $templateProcessor->setValue('price#' . $i, number_format(floatval($item['price']), 2));
            $templateProcessor->setValue('subtotal#' . $i, number_format(floatval($item['quantity']) * floatval($item['price']), 2));
            
            if (!empty($item['item_picture'])) {
                // DB stores path like '/uploads/items/image-xxx.jpeg' - strip leading slash for absolute path
                $pictureName = ltrim($item['item_picture'], '/');
                // Try React backend uploads dir first
                $reactUploadsBase = 'c:/Users/apal6/OneDrive/Desktop/uac/fullFlow/f2cReact/backend/';
                $imagePath = $reactUploadsBase . $pictureName;
                
                // Fallback to PHP project uploads
                if (!file_exists($imagePath)) {
                    // Maybe stored as just filename
                    $filename = basename($item['item_picture']);
                    $imagePath = $reactUploadsBase . 'uploads/items/' . $filename;
                }
                // Fallback to PHP project
                if (!file_exists($imagePath)) {
                    $imagePath = 'c:/Users/apal6/OneDrive/Desktop/uac/fullFlow/LiveF2cERp/LiveF2cERp/uploads/items/' . basename($item['item_picture']);
                }
                
                if (file_exists($imagePath) && is_file($imagePath)) {
                    try {
                        $templateProcessor->setImageValue('item_picture#' . $i, array('path' => $imagePath, 'width' => 150, 'height' => 150, 'ratio' => false));
                    } catch (Exception $imgEx) {
                        $templateProcessor->setValue('item_picture#' . $i, '');
                    }
                } else {
                    $templateProcessor->setValue('item_picture#' . $i, '');
                }
            } else {
                $templateProcessor->setValue('item_picture#' . $i, '');
            }
            
            $i++;
        }
    } else {
        $templateProcessor->cloneRow('item_no', 1);
        $templateProcessor->setValue('item_no#1', '');
        $templateProcessor->setValue('serial_number#1', '');
        $templateProcessor->setValue('description#1', 'No items');
        $templateProcessor->setValue('quantity#1', '');
        $templateProcessor->setValue('price#1', '');
        $templateProcessor->setValue('subtotal#1', '');
        $templateProcessor->setValue('item_picture#1', '');
    }
    
    $templateProcessor->saveAs($outputPath);
    echo trim($outputPath);
    exit(0);
} catch (Exception $e) {
    echo "ERROR: " . $e->getMessage();
    exit(1);
}

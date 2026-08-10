const ExcelJS = require('exceljs');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType } = require('docx');
const { generatePODocxFromTemplate } = require('./generatePODocxFromTemplate');

/**
 * Generate a standard Purchase Order DOCX document using the PHP template.
 */
async function generatePODocx(poData, poItems, companyData) {
  return generatePODocxFromTemplate(poData, poItems, companyData);
}

/**
 * Generate a standard Purchase Order XLSX document.
 */
async function generatePOXlsx(poData, poItems, companyData) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Purchase Order');

  // Set column widths matching PHP
  sheet.getColumn('A').width = 20;
  sheet.getColumn('B').width = 30;
  sheet.getColumn('C').width = 15;
  sheet.getColumn('D').width = 40;
  sheet.getColumn('E').width = 15;
  sheet.getColumn('F').width = 15;
  sheet.getColumn('G').width = 15;
  sheet.getColumn('H').width = 20;

  let currentRow = 1;

  // Title
  sheet.getCell(`A${currentRow}`).value = 'PURCHASE ORDER';
  sheet.mergeCells(`A${currentRow}:H${currentRow}`);
  sheet.getCell(`A${currentRow}`).font = { bold: true, size: 16 };
  sheet.getCell(`A${currentRow}`).alignment = { horizontal: 'center' };
  currentRow += 2;

  // PO Details Section
  sheet.getCell(`A${currentRow}`).value = 'PO Details';
  sheet.getCell(`A${currentRow}`).font = { bold: true, size: 14 };
  sheet.getCell(`A${currentRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  sheet.mergeCells(`A${currentRow}:H${currentRow}`);
  currentRow++;

  // PO Information
  const poDetails = [
    { label: 'PO Number', value: poData.po_number || '' },
    { label: 'PO Date', value: poData.po_date ? new Date(poData.po_date).toLocaleDateString('en-GB') : '' },
    { label: 'Buyer', value: poData.buyer || '' },
    { label: 'Buyer Address', value: poData.buyer_address || '' },
    { label: 'Factory', value: poData.factory || '' },
    { label: 'Factory Email', value: poData.factory_email || '' },
    { label: 'Factory Address', value: poData.factory_address || '' },
    { label: 'Delivery Date', value: poData.po_delivery_date ? new Date(poData.po_delivery_date).toLocaleDateString('en-GB') : '' },
    { label: 'Special Comments', value: poData.special_comments || '' }
  ];

  poDetails.forEach(detail => {
    sheet.getCell(`A${currentRow}`).value = detail.label;
    sheet.getCell(`B${currentRow}`).value = detail.value;
    sheet.getCell(`A${currentRow}`).font = { bold: true };
    
    if (['Buyer Address', 'Factory Address', 'Special Comments'].includes(detail.label)) {
      sheet.getCell(`B${currentRow}`).alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(currentRow).height = 30;
    }
    currentRow++;
  });

  currentRow += 2;

  // Items Section
  sheet.getCell(`A${currentRow}`).value = 'Items';
  sheet.getCell(`A${currentRow}`).font = { bold: true, size: 14 };
  sheet.getCell(`A${currentRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  sheet.mergeCells(`A${currentRow}:H${currentRow}`);
  currentRow++;

  // Items Header
  const headers = ['Item No', 'Serial Number', 'Description', 'Quantity', 'Price', 'Subtotal', 'Image'];
  const headerCols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

  headers.forEach((header, index) => {
    const cell = sheet.getCell(`${headerCols[index]}${currentRow}`);
    cell.value = header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6E6' } };
    cell.border = {
      top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' }
    };
  });
  currentRow++;

  // Items Data
  let grandTotal = 0;
  if (poItems && poItems.length > 0) {
    poItems.forEach(item => {
      const itemRow = currentRow;
      const subtotal = (item.quantity || 0) * (item.price || 0);
      grandTotal += subtotal;

      sheet.getCell(`A${itemRow}`).value = item.item_no || '';
      sheet.getCell(`B${itemRow}`).value = item.serial_number || '';
      sheet.getCell(`C${itemRow}`).value = item.description || '';
      sheet.getCell(`D${itemRow}`).value = Number(item.quantity) || 0;
      sheet.getCell(`E${itemRow}`).value = Number(item.price) || 0;
      sheet.getCell(`F${itemRow}`).value = subtotal;
      sheet.getCell(`G${itemRow}`).value = item.item_picture ? 'Image URL' : 'No Image';

      // Formatting
      sheet.getCell(`E${itemRow}`).numFmt = '"$"#,##0.00';
      sheet.getCell(`F${itemRow}`).numFmt = '"$"#,##0.00';
      sheet.getCell(`C${itemRow}`).alignment = { wrapText: true, vertical: 'top' };
      
      headerCols.forEach(col => {
        sheet.getCell(`${col}${itemRow}`).border = {
          top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' }
        };
      });

      currentRow++;
    });
  } else {
    sheet.getCell(`A${currentRow}`).value = 'No items found';
    sheet.mergeCells(`A${currentRow}:G${currentRow}`);
    sheet.getCell(`A${currentRow}`).alignment = { horizontal: 'center' };
    currentRow++;
  }

  // Total Row
  currentRow++;
  sheet.getCell(`E${currentRow}`).value = 'Total:';
  sheet.getCell(`F${currentRow}`).value = grandTotal;
  sheet.getCell(`F${currentRow}`).numFmt = '"$"#,##0.00';
  
  ['E', 'F'].forEach(col => {
    const cell = sheet.getCell(`${col}${currentRow}`);
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD700' } };
    cell.border = {
      top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  return await workbook.xlsx.writeBuffer();
}

/**
 * Generate an Invoice DOCX document.
 */
async function generateInvoiceDocx(saleData, saleItems, companyData) {
  const tableRows = [
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ text: "Item Name", style: "bold" })] }),
        new TableCell({ children: [new Paragraph({ text: "Quantity", style: "bold" })] }),
        new TableCell({ children: [new Paragraph({ text: "Unit Price", style: "bold" })] }),
        new TableCell({ children: [new Paragraph({ text: "Total", style: "bold" })] }),
      ],
    }),
  ];

  saleItems.forEach(item => {
    tableRows.push(
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(item.item_name || 'Item')] }),
          new TableCell({ children: [new Paragraph(String(item.quantity || 0))] }),
          new TableCell({ children: [new Paragraph(`$${(item.unit_price || 0).toFixed(2)}`)] }),
          new TableCell({ children: [new Paragraph(`$${(item.total_price || 0).toFixed(2)}`)] }),
        ],
      })
    );
  });

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: companyData.company_name || 'COMPANY NAME', bold: true, size: 36 }),
            ],
            spacing: { after: 200 },
          }),
          new Paragraph({ text: "INVOICE", heading: "Heading1", alignment: "center", spacing: { after: 400 } }),
          new Paragraph(`Invoice / Sale ID: ${saleData.sale_id || 'N/A'}`),
          new Paragraph(`Date: ${saleData.sale_date ? new Date(saleData.sale_date).toLocaleDateString() : 'N/A'}`),
          new Paragraph({ text: "", spacing: { after: 200 } }),
          new Paragraph({ text: "Bill To:", bold: true }),
          new Paragraph(`${saleData.customer_name || 'N/A'}`),
          new Paragraph({ text: "", spacing: { after: 400 } }),
          new Table({
            rows: tableRows,
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),
          new Paragraph({ text: "", spacing: { after: 200 } }),
          new Paragraph({
            children: [
              new TextRun({ text: `Total Amount: $${(saleData.total_amount || 0).toFixed(2)}`, bold: true, size: 28 }),
            ],
            alignment: "right",
          }),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

module.exports = {
  generatePODocx,
  generatePOXlsx,
  generateInvoiceDocx
};

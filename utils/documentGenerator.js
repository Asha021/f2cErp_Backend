const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const ExcelJS = require('exceljs');

/**
 * Generate a standard Purchase Order DOCX document.
 */
async function generatePODocx(poData, poItems, companyData) {
  // Create table rows for items
  const tableRows = [
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ text: "Item #", style: "bold" })] }),
        new TableCell({ children: [new Paragraph({ text: "Description", style: "bold" })] }),
        new TableCell({ children: [new Paragraph({ text: "Quantity", style: "bold" })] }),
        new TableCell({ children: [new Paragraph({ text: "Price", style: "bold" })] }),
        new TableCell({ children: [new Paragraph({ text: "Total", style: "bold" })] }),
      ],
    }),
  ];

  let grandTotal = 0;
  poItems.forEach(item => {
    const total = (item.quantity * item.price);
    grandTotal += total;
    tableRows.push(
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(item.item_no || '')] }),
          new TableCell({ children: [new Paragraph(item.description || '')] }),
          new TableCell({ children: [new Paragraph(String(item.quantity || 0))] }),
          new TableCell({ children: [new Paragraph(`$${(item.price || 0).toFixed(2)}`)] }),
          new TableCell({ children: [new Paragraph(`$${total.toFixed(2)}`)] }),
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
          new Paragraph({ text: "PURCHASE ORDER", heading: "Heading1", alignment: "center", spacing: { after: 400 } }),
          new Paragraph(`PO Number: ${poData.po_number || 'N/A'}`),
          new Paragraph(`PO Date: ${poData.po_date ? new Date(poData.po_date).toLocaleDateString() : 'N/A'}`),
          new Paragraph(`Delivery Date: ${poData.po_delivery_date ? new Date(poData.po_delivery_date).toLocaleDateString() : 'N/A'}`),
          new Paragraph({ text: "", spacing: { after: 200 } }),
          new Paragraph({ text: "Supplier:", bold: true }),
          new Paragraph(`${poData.factory || 'N/A'}`),
          new Paragraph(`${poData.factory_address || ''}`),
          new Paragraph({ text: "", spacing: { after: 400 } }),
          new Table({
            rows: tableRows,
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),
          new Paragraph({ text: "", spacing: { after: 200 } }),
          new Paragraph({
            children: [
              new TextRun({ text: `Grand Total: $${grandTotal.toFixed(2)}`, bold: true, size: 28 }),
            ],
            alignment: "right",
          }),
          new Paragraph({ text: "", spacing: { after: 400 } }),
          new Paragraph({ text: "Special Comments / Instructions:", bold: true }),
          new Paragraph(poData.special_comments || 'None'),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

/**
 * Generate a standard Purchase Order XLSX document.
 */
async function generatePOXlsx(poData, poItems, companyData) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Purchase Order');

  sheet.columns = [
    { header: 'Item Number', key: 'item_no', width: 15 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Price', key: 'price', width: 15 },
    { header: 'Total', key: 'total', width: 15 },
  ];

  sheet.insertRow(1, [companyData.company_name || 'COMPANY NAME']);
  sheet.insertRow(2, ['PURCHASE ORDER']);
  sheet.insertRow(3, [`PO Number: ${poData.po_number}`]);
  sheet.insertRow(4, [`Supplier: ${poData.factory}`]);
  sheet.insertRow(5, []); // blank
  
  sheet.getRow(6).values = ['Item Number', 'Description', 'Quantity', 'Price', 'Total'];
  sheet.getRow(6).font = { bold: true };

  let startRow = 7;
  let grandTotal = 0;
  poItems.forEach(item => {
    const total = item.quantity * item.price;
    grandTotal += total;
    sheet.getRow(startRow).values = [
      item.item_no || '',
      item.description || '',
      item.quantity || 0,
      item.price || 0,
      total
    ];
    startRow++;
  });

  sheet.getRow(startRow + 1).values = ['', '', '', 'Grand Total:', grandTotal];
  sheet.getRow(startRow + 1).font = { bold: true };

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

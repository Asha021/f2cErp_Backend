const ExcelJS = require('exceljs');
async function read() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('templates/UAC-OFC-Chart.xlsx');
  const ws = wb.worksheets[0];
  console.log('Total rows:', ws.rowCount);
  console.log('Total cols:', ws.columnCount);
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 10) {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        vals.push({ col: colNumber, val: cell.value, type: cell.type });
      });
      console.log('Row ' + rowNumber + ':', JSON.stringify(vals));
    }
  });
}
read().catch(console.error);

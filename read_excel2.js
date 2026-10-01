const ExcelJS = require('exceljs');
async function read() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('templates/UAC-OFC-Chart.xlsx');
  const ws = wb.worksheets[0];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber >= 6 && rowNumber <= 10) {
      console.log('Row ' + rowNumber + ':', JSON.stringify(row.values));
    }
  });
}
read();

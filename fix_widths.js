const fs = require('fs');
const PizZip = require('pizzip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

function fixWidths() {
    const templatePath = './templates/po_template_clean.docx';
    const content = fs.readFileSync(templatePath, 'binary');
    const zip = new PizZip(content);

    const headerXmlStr = zip.file('word/header2.xml').asText();
    const doc = new DOMParser().parseFromString(headerXmlStr, 'text/xml');

    const tables = doc.getElementsByTagName('w:tbl');
    if (tables.length === 0) {
        console.log("No tables found in header2.xml");
        return;
    }

    // We know the target table is the first one
    const tbl = tables[0];

    // 1. Update tblGrid
    const tblGrid = tbl.getElementsByTagName('w:tblGrid')[0];
    const gridCols = tblGrid.getElementsByTagName('w:gridCol');
    
    // col 3 (PO Date value) original ~2544, let's make it 1844
    // col 4 (Revision) original ~1425, let's make it 2125
    if (gridCols.length >= 5) {
        let col3w = parseInt(gridCols[3].getAttribute('w:w'));
        let col4w = parseInt(gridCols[4].getAttribute('w:w'));
        
        let shift = 700; // shift 700 dxa from PO Date to Revision
        gridCols[3].setAttribute('w:w', String(col3w - shift));
        gridCols[4].setAttribute('w:w', String(col4w + shift));
    }

    // 2. Update each row's cells
    const rows = tbl.getElementsByTagName('w:tr');
    for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].getElementsByTagName('w:tc');
        if (cells.length >= 5) {
            // PO date value is cells[3], Revision is cells[4]
            const tcPr3 = cells[3].getElementsByTagName('w:tcPr')[0];
            const tcW3 = tcPr3.getElementsByTagName('w:tcW')[0];
            let w3 = parseInt(tcW3.getAttribute('w:w'));
            tcW3.setAttribute('w:w', String(w3 - 700));

            const tcPr4 = cells[4].getElementsByTagName('w:tcPr')[0];
            const tcW4 = tcPr4.getElementsByTagName('w:tcW')[0];
            let w4 = parseInt(tcW4.getAttribute('w:w'));
            tcW4.setAttribute('w:w', String(w4 + 700));
        }
    }

    // Save back
    const newXml = new XMLSerializer().serializeToString(doc);
    zip.file('word/header2.xml', newXml);

    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(templatePath, buf);
    console.log('Successfully adjusted template column widths!');
}

fixWidths();

const fs = require('fs');
const PizZip = require('pizzip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const content = fs.readFileSync('./templates/po_template.docx', 'binary');
const zip = new PizZip(content);
const xmlString = zip.file('word/document.xml').asText();

const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
const rows = doc.getElementsByTagName('w:tr');
let targetRow = null;

for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let textContent = '';
    const texts = row.getElementsByTagName('w:t');
    for (let j = 0; j < texts.length; j++) {
        if (texts[j].firstChild) {
            textContent += texts[j].firstChild.nodeValue;
        }
    }
    if (textContent.includes('item_no')) {
        targetRow = row;
        break;
    }
}

if (targetRow) {
    console.log('Found target row!');
    
    // In docxtemplater, we need ${#items} in the first cell's first paragraph
    const firstCell = targetRow.getElementsByTagName('w:tc')[0];
    const firstPara = firstCell.getElementsByTagName('w:p')[0];
    const newRunStart = doc.createElement('w:r');
    const newTextStart = doc.createElement('w:t');
    newTextStart.appendChild(doc.createTextNode('${#items}'));
    newRunStart.appendChild(newTextStart);
    firstPara.insertBefore(newRunStart, firstPara.firstChild);

    // And ${/items} in the last cell's last paragraph
    const cells = targetRow.getElementsByTagName('w:tc');
    const lastCell = cells[cells.length - 1];
    const paras = lastCell.getElementsByTagName('w:p');
    const lastPara = paras[paras.length - 1];
    const newRunEnd = doc.createElement('w:r');
    const newTextEnd = doc.createElement('w:t');
    newTextEnd.appendChild(doc.createTextNode('${/items}'));
    newRunEnd.appendChild(newTextEnd);
    lastPara.appendChild(newRunEnd);

    const newXml = new XMLSerializer().serializeToString(doc);
    zip.file('word/document.xml', newXml);
    
    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync('./templates/po_template_node.docx', buf);
    console.log('Saved modified template to po_template_node.docx');
} else {
    console.log('Row not found');
}

const fs = require('fs');
const xml = fs.readFileSync('test_doc.xml', 'utf8');
const rowRegex = /<w:tr[\s>](?:(?!<w:tr[\s>]).)*?item_no(?:.*?<\/w:tr>)/s;
const match = xml.match(rowRegex);
if(match) {
    console.log('Row found!', match[0].length, 'characters');
} else {
    console.log('Row not found with regex');
}


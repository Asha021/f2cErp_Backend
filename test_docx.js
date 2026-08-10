const fs = require('fs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ImageModule = require('docxtemplater-image-module-free');
const path = require('path');

async function testDocx() {
    const zip = new PizZip(fs.readFileSync('templates/po_template_clean.docx'));
    
    // Process document.xml
    let xml = zip.file('word/document.xml').asText();
    const rowRegex = /<w:tr[\s>](?:(?!<w:tr[\s>]).)*?\$\{.*?item_no.*?\}(?:(?!<\/w:tr>).)*?<\/w:tr>/s;
    const match = xml.match(rowRegex);
    
    const itemsCount = 1;
    if (match) {
        const rowXml = match[0];
        let newXml = '';
        for (let i = 1; i <= itemsCount; i++) {
            let cloned = rowXml.replace(/\$\{([^}]+)\}/g, (m, p1) => {
                if(p1 === 'item_picture') return '{%item_picture_' + i + '}';
                return '{{' + p1 + '_' + i + '}}';
            });
            newXml += cloned;
        }
        xml = xml.replace(rowRegex, newXml);
        zip.file('word/document.xml', xml);
    }
    
    // Process all XMLs to replace ${...} with {{...}}
    for (let key in zip.files) {
        if (key.endsWith('.xml')) {
            let fileXml = zip.files[key].asText();
            fileXml = fileXml.replace(/\$\{([^}]+)\}/g, '{{$1}}');
            zip.file(key, fileXml);
        }
    }

    const opts = {
        centered: false,
        getImage: function(tagValue) {
            return fs.readFileSync(tagValue);
        },
        getSize: function() {
            return [150, 150];
        }
    };
    
    const doc = new Docxtemplater(zip, { modules: [new ImageModule(opts)], paragraphLoop: true, linebreaks: true });
    
    doc.render({
        po_number: 'TEST-123',
        item_no_1: 'IT-01',
        description_1: 'Test description',
        quantity_1: 5,
        price_1: '10.00',
        subtotal_1: '50.00',
        // item_picture_1: ...
    });
    
    const buf = doc.getZip().generate({ type: 'nodebuffer' });
    fs.writeFileSync('test_out.docx', buf);
    console.log('Done!');
}

testDocx().catch(console.error);

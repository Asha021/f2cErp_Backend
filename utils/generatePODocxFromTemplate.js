const fs = require('fs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ImageModule = require('docxtemplater-image-module-free');
const path = require('path');

async function generatePODocxFromTemplate(poData, poItems, companyData) {
    const templatePath = path.join(__dirname, '../templates/po_template_clean.docx');
    const zip = new PizZip(fs.readFileSync(templatePath));
    
    let xml = zip.file('word/document.xml').asText();
    const rowRegex = /<w:tr[\s>](?:(?!<w:tr[\s>]).)*?\$\{.*?item_no.*?\}(?:(?!<\/w:tr>).)*?<\/w:tr>/s;
    const match = xml.match(rowRegex);
    
    const itemsCount = Math.max(1, poItems ? poItems.length : 1);
    
    if (match) {
        const rowXml = match[0];
        let newXml = '';
        for (let i = 1; i <= itemsCount; i++) {
            let cloned = rowXml.replace(/\$\{([^}]+)\}/g, (m, p1) => {
                if (p1 === 'item_picture') return '{%item_picture_' + i + '}';
                return '{' + p1 + '_' + i + '}';
            });
            newXml += cloned;
        }
        xml = xml.replace(rowRegex, newXml);
        zip.file('word/document.xml', xml);
    }
    
    // Replace ${...} with {...} in all XMLs
    for (let key in zip.files) {
        if (key.endsWith('.xml')) {
            let fileXml = zip.files[key].asText();
            fileXml = fileXml.replace(/\$\{([^}]+)\}/g, '{$1}');
            zip.file(key, fileXml);
        }
    }

    const dummyImageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    
    const opts = {
        centered: false,
        getImage: function(tagValue) {
            if (!tagValue || tagValue === 'empty') return dummyImageBuffer;
            try {
                return fs.readFileSync(tagValue);
            } catch (e) {
                return dummyImageBuffer;
            }
        },
        getSize: function() {
            return [150, 150];
        }
    };
    
    const doc = new Docxtemplater(zip, { modules: [new ImageModule(opts)], paragraphLoop: true, linebreaks: true });
    
    // Format poData
    const data = {
        po_number: poData.po_number || '',
        po_date: poData.po_date ? new Date(poData.po_date).toLocaleDateString('en-GB') : '',
        buyer: poData.buyer || '',
        buyer_address: poData.buyer_address || '',
        factory: poData.factory || '',
        factory_email: poData.factory_email || '',
        factory_address: poData.factory_address || '',
        delivery_date: poData.po_delivery_date ? new Date(poData.po_delivery_date).toLocaleDateString('en-GB') : '',
        special_comments: poData.special_comments || ''
    };
    
    if (poItems && poItems.length > 0) {
        poItems.forEach((item, index) => {
            const i = index + 1;
            data[`item_no_${i}`] = item.item_no || '';
            data[`serial_number_${i}`] = item.serial_number || '';
            data[`description_${i}`] = item.description || item.item_name || '';
            data[`quantity_${i}`] = item.quantity || '';
            data[`price_${i}`] = item.price ? Number(item.price).toFixed(2) : '';
            data[`subtotal_${i}`] = (item.quantity && item.price) ? (Number(item.quantity) * Number(item.price)).toFixed(2) : '';
            
            // Image handling
            let imagePathToUse = null;
            if (item.item_picture) {
                const pictureName = item.item_picture.replace(/^[/]+/, '');
                const backendDir = path.join(__dirname, '..');
                const p1 = path.join(backendDir, pictureName);
                const p2 = path.join(backendDir, 'uploads', 'items', path.basename(pictureName));
                const p3 = 'c:/Users/apal6/OneDrive/Desktop/uac/fullFlow/LiveF2cERp/LiveF2cERp/uploads/items/' + path.basename(pictureName);
                
                if (fs.existsSync(p1)) imagePathToUse = p1;
                else if (fs.existsSync(p2)) imagePathToUse = p2;
                else if (fs.existsSync(p3)) imagePathToUse = p3;
            }
            if (imagePathToUse) {
                data[`item_picture_${i}`] = imagePathToUse;
            } else {
                data[`item_picture_${i}`] = 'empty';
            }
        });
    } else {
        data['item_no_1'] = '';
        data['serial_number_1'] = '';
        data['description_1'] = 'No items';
        data['quantity_1'] = '';
        data['price_1'] = '';
        data['subtotal_1'] = '';
    }
    
    doc.render(data);
    return doc.getZip().generate({ type: 'nodebuffer' });
}

module.exports = { generatePODocxFromTemplate };

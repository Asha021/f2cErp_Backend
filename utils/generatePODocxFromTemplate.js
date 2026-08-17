const fs = require('fs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ImageModule = require('docxtemplater-image-module-free');
const path = require('path');
const https = require('https');
const http = require('http');

// Fetch image from a URL and return as Buffer
function fetchImageBuffer(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// Safe date formatter — avoids UTC/local timezone shift on MySQL date strings
// MySQL returns 'YYYY-MM-DD' strings; new Date('YYYY-MM-DD') parses as UTC midnight
// which can roll back a day in local timezones. This splits directly.
function formatDate(val) {
    if (!val) return '';
    const str = String(val).substring(0, 10); // take 'YYYY-MM-DD' part only
    const parts = str.split('-');
    if (parts.length !== 3) return str;
    return `${parts[2]}/${parts[1]}/${parts[0]}`; // DD/MM/YYYY
}

async function generatePODocxFromTemplate(poData, poItems, companyData) {
    const templatePath = path.join(__dirname, '../templates/po_template_clean.docx');
    const zip = new PizZip(fs.readFileSync(templatePath));

    let xml = zip.file('word/document.xml').asText();

        // ── Remove Empty Spacer Rows ──────────────────────────────────────────
    // The Word template contains 7 hardcoded empty rows under the main item row.
    // If we don't delete them, they push the table down and create blank pages.
    const emptyRowRegex = /<w:tr[ >][\s\S]*?<\/w:tr>/g;
    let emptyMatch;
    let rowsToRemove = [];
    while ((emptyMatch = emptyRowRegex.exec(xml)) !== null) {
        const trXml = emptyMatch[0];
        const text = (trXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('').trim();
        if (text === '') rowsToRemove.push(trXml);
    }
    rowsToRemove.forEach(row => {
        xml = xml.replace(row, '');
    });
    
    // ── Find and clone the items data row ─────────────────────────────────
    // Template structure (confirmed by inspection):
    //   Row 1: PO header row — contains ${delivery_date}
    //   Row 2: Column headers (SERIAL NBR, ITEM NO, etc.) — no placeholders
    //   Row 3: Items DATA row — contains ${serial_number}, ${item_no}, ${description}, etc.
    // We must clone Row 3 (N times for N items) and leave Row 1 untouched.

    const itemsCount = Math.max(1, poItems ? poItems.length : 1);
    let rowMatched = false;

    // Iterate all <w:tr ...>...</w:tr> blocks and find the items data row
    // (the one with ${serial_number} OR ${quantity} but NOT ${delivery_date})
    const trRegex = /(<w:tr[ >][\s\S]*?<\/w:tr>)/g;
    let trMatch;
    while ((trMatch = trRegex.exec(xml)) !== null) {
        const rowXml = trMatch[1];
        const hasItemPlaceholder = rowXml.includes('${serial_number}') ||
                                   rowXml.includes('${item_no}') ||
                                   rowXml.includes('${quantity}');
        const isDeliveryRow = rowXml.includes('${delivery_date}');

        if (hasItemPlaceholder && !isDeliveryRow) {
            // Clone this row N times, replacing ${X} with {X_i}
            let newXml = '';
            for (let i = 1; i <= itemsCount; i++) {
                let cloned = rowXml.replace(/\$\{([^}]+)\}/g, (m, p1) => {
                    if (p1 === 'item_picture') return '{%item_picture_' + i + '}';
                    return '{' + p1 + '_' + i + '}';
                });
                newXml += cloned;
            }
            xml = xml.replace(rowXml, newXml);
            zip.file('word/document.xml', xml);
            rowMatched = true;
            break;
        }
    }

    if (!rowMatched) {
        console.warn('[DOCX] Warning: Could not find items data row in template.');
    }

    // Replace ${...} with {...} in all XMLs
    for (let key in zip.files) {
        if (key.endsWith('.xml')) {
            let fileXml = zip.files[key].asText();
            fileXml = fileXml.replace(/\$\{([^}]+)\}/g, '{$1}');
            zip.file(key, fileXml);
        }
    }

    const dummyImageBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
    );

    // ── Pre-fetch ALL images BEFORE rendering ───────────────────────────────
    // docxtemplater's getImage() must be synchronous, so we fetch async here first
    const imageCache = {}; // 'item_picture_1' → Buffer | null

    if (poItems && poItems.length > 0) {
        for (let index = 0; index < poItems.length; index++) {
            const item = poItems[index];
            const i = index + 1;
            const pic = item.item_picture;

            if (!pic) {
                imageCache[`item_picture_${i}`] = null;
                continue;
            }

            // Cloudinary / any HTTP URL (new behavior)
            if (/^https?:\/\//i.test(pic)) {
                try {
                    imageCache[`item_picture_${i}`] = await fetchImageBuffer(pic);
                } catch (e) {
                    console.warn(`[DOCX] Failed to fetch image: ${pic}`, e.message);
                    imageCache[`item_picture_${i}`] = null;
                }
            } else {
                // Fallback: local file path (for old records stored as /uploads/items/...)
                const pictureName = pic.replace(/^[/]+/, '');
                const backendDir = path.join(__dirname, '..');
                const p1 = path.join(backendDir, pictureName);
                const p2 = path.join(backendDir, 'uploads', 'items', path.basename(pictureName));

                if (fs.existsSync(p1)) {
                    imageCache[`item_picture_${i}`] = fs.readFileSync(p1);
                } else if (fs.existsSync(p2)) {
                    imageCache[`item_picture_${i}`] = fs.readFileSync(p2);
                } else {
                    imageCache[`item_picture_${i}`] = null;
                }
            }
        }
    }

    // ── Docxtemplater image module ──────────────────────────────────────────
    const opts = {
        centered: false,
        getImage: function (tagValue) {
            // tagValue is the data value we set: either a cache key ('item_picture_1') or 'empty'
            if (!tagValue || tagValue === 'empty') return dummyImageBuffer;
            const buf = imageCache[tagValue];
            return buf || dummyImageBuffer;
        },
        getSize: function () {
            return [150, 150];
        }
    };

    const doc = new Docxtemplater(zip, {
        modules: [new ImageModule(opts)],
        paragraphLoop: true,
        linebreaks: true,
        // KEY FIX: without nullGetter, any tag not found in data renders as
        // literal "undefined" string. This makes missing tags render as ''.
        nullGetter() { return ''; }
    });

    // ── Build template data object ─────────────────────────────────────────
    const data = {
        po_number:        poData.po_number || '',
        po_date:          formatDate(poData.po_date),
        buyer:            poData.buyer || '',
        buyer_address:    poData.buyer_address || '',
        factory:          poData.factory || '',
        factory_email:    poData.factory_email || '',
        factory_address:  poData.factory_address || '',
        // Both key variants — template may use {delivery_date} OR {po_delivery_date}
        delivery_date:    formatDate(poData.po_delivery_date),
        po_delivery_date: formatDate(poData.po_delivery_date),
        special_comments: poData.special_comments || ''
    };

    if (poItems && poItems.length > 0) {
        poItems.forEach((item, index) => {
            const i = index + 1;
            data[`item_no_${i}`]       = item.item_no || '';
            data[`serial_number_${i}`] = item.serial_number || '';
            data[`description_${i}`]   = item.description || item.item_name || '';
            data[`quantity_${i}`]      = item.quantity || '';
            data[`price_${i}`]         = item.price ? Number(item.price).toFixed(2) : '';
            data[`subtotal_${i}`]      = (item.quantity && item.price)
                ? (Number(item.quantity) * Number(item.price)).toFixed(2)
                : '';

            // Set cache key as the value — getImage() will resolve it from imageCache
            const cacheKey = `item_picture_${i}`;
            data[cacheKey] = imageCache[cacheKey] ? cacheKey : 'empty';
        });

        
    } else {
        data['item_no_1']       = '';
        data['serial_number_1'] = '';
        data['description_1']   = 'No items';
        data['quantity_1']      = '';
        data['price_1']         = '';
        data['subtotal_1']      = '';
        data['item_picture_1']  = 'empty';
    }

    doc.render(data);
    return doc.getZip().generate({ type: 'nodebuffer' });
}

module.exports = { generatePODocxFromTemplate };

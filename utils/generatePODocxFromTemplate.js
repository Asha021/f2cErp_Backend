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
        let rowXml = trMatch[1];
        const hasItemPlaceholder = rowXml.includes('${serial_number}') ||
            rowXml.includes('${item_no}') ||
            rowXml.includes('${quantity}');
        const isDeliveryRow = rowXml.includes('${delivery_date}');

        if (hasItemPlaceholder && !isDeliveryRow) {
            const originalRowXml = rowXml; // save original BEFORE modifications for xml.replace()

            // 1. Add <w:vAlign w:val="center"/> to any <w:tcPr> that doesn't have it (QTY, PRICE, SUBTOTAL, SPECIAL COMMENTS cells)
            rowXml = rowXml.replace(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/g, (match, tcPrInner) => {
                if (!tcPrInner.includes('<w:vAlign')) {
                    return `<w:tcPr>${tcPrInner}<w:vAlign w:val="center"/></w:tcPr>`;
                }
                return match.replace(/<w:vAlign[^/]*\/>/, '<w:vAlign w:val="center"/>');
            });

            // 2. Remove empty filler <w:p> paragraphs from QTY, PRICE, SUBTOTAL, SPECIAL COMMENTS cells.
            // The template has 2-4 empty <w:p> blocks above the content as vertical spacers —
            // these push text to the bottom even when vAlign=center is applied on the cell.
            rowXml = rowXml.replace(/<w:tc>([\s\S]*?)<\/w:tc>/g, (tcMatch, tcInner) => {
                const isDataCell = /\$\{(quantity|price|subtotal|special_comments)\}/.test(tcInner);
                if (!isDataCell) return tcMatch;
                // Remove empty <w:p> that have NO <w:t> inside (filler paragraphs)
                const cleaned = tcInner.replace(/<w:p\b[^>]*>(?:(?!<w:t>|<w:t ).)*?<\/w:p>/gs, (pMatch) => {
                    return /<w:t[\s>]/.test(pMatch) ? pMatch : '';
                });
                return `<w:tc>${cleaned}</w:tc>`;
            });

            // 3. Normalize paragraph spacing so rows size consistently
            rowXml = rowXml.replace(/<w:spacing[^/]*\/>/g, '<w:spacing w:after="0" w:before="0" w:line="240" w:lineRule="auto"/>');

            // Clone this row N times, replacing ${X} with {X_i}
            let newXml = '';
            for (let i = 1; i <= itemsCount; i++) {
                const item = poItems && poItems[i - 1] ? poItems[i - 1] : null;
                const hasPic = item && item.item_picture && item.item_picture.trim() !== '';

                let cloned = rowXml.replace(/\$\{([^}]+)\}/g, (m, p1) => {
                    const cleanP1 = p1.replace(/<[^>]+>/g, '').trim();
                    if (cleanP1 === 'item_picture') {
                        return hasPic ? '{%' + p1 + '_' + i + '}' : '{' + p1 + '_' + i + '}';
                    }
                    return '{' + p1 + '_' + i + '}';
                });
                newXml += cloned;
            }
            xml = xml.replace(originalRowXml, newXml); // use ORIGINAL (unmodified) for matching
            zip.file('word/document.xml', xml);
            rowMatched = true;
            break;
        }
    }

    if (!rowMatched) {
        console.warn('[DOCX] Warning: Could not find items data row in template.');
    }

    // (Duplicate Dear Sir removal removed)

    // ── Fix Top Spacing & T&C Gap ─────────────────────────────────────────────
    
    const tblEnd = xml.lastIndexOf('</w:tbl>');
    if (tblEnd !== -1) {
        let beforeTableEnd = xml.slice(0, tblEnd);
        let afterTable = xml.slice(tblEnd);

        // 0. Remove the empty spacer paragraphs just before "Dear Sir,"
        // Also remove the leading spaces from the "Dear Sir," paragraph to pull it left if it was indented.
        beforeTableEnd = beforeTableEnd.replace(
            /<w:p[^>]*>[\s\S]*?<w:t[^>]*>\s+<\/w:t>[\s\S]*?<\/w:p>(?=\s*<w:p[^>]*>[\s\S]*?Dear Sir,)/g,
            ''
        );
        beforeTableEnd = beforeTableEnd.replace(
            /(<w:p[^>]*>[\s\S]*?<w:r[^>]*>[\s\S]*?<w:t[^>]*>)\s+(<\/w:t>[\s\S]*?Dear Sir,)/g,
            '$1$2'
        );

        // 0.5 Reduce the top margin of the first page to bring the body closer to the header table
        beforeTableEnd = beforeTableEnd.replace(/<w:pgMar w:top="720"/, '<w:pgMar w:top="360"');

        // 1. Inject <w:type w:val="continuous"/> into the section break
        afterTable = afterTable.replace(
            /(<w:sectPr[^>]*>)/,
            '$1<w:type w:val="continuous"/>'
        );

        // 2. Make Section 2's margins EXACTLY match Section 1's (720) 
        // Word strictly forces a page break if page margins differ.
        afterTable = afterTable.replace(/w:top="1987"/g, 'w:top="720"');
        afterTable = afterTable.replace(/w:right="1440"/g, 'w:right="720"');
        afterTable = afterTable.replace(/w:left="1440"/g, 'w:left="720"');
        afterTable = afterTable.replace(/w:bottom="1440"/g, 'w:bottom="720"');

        // 3. Because we reduced the page's left margin from 1440 to 720 (lost 720 twips),
        // we must ADD 720 twips of left indent to EVERY paragraph in T&C to restore
        // the original visual alignment. This includes the heading itself, which lacks a pPr.
        afterTable = afterTable.replace(/<w:p(\s[^>]*|)>([\s\S]*?)<\/w:p>/g, (match, pAttrs, pInner) => {
            if (pInner.includes('<w:pPr>')) {
                // It has a pPr, so modify the existing pPr
                pInner = pInner.replace(/<w:pPr>(.*?)<\/w:pPr>/, (pPrMatch, pPrInner) => {
                    if (pPrInner.includes('<w:ind ')) {
                        pPrInner = pPrInner.replace(/<w:ind([^>]+)\/>/, (indMatch, indAttrs) => {
                            let newAttrs = indAttrs;
                            if (newAttrs.includes('w:left=')) {
                                newAttrs = newAttrs.replace(/w:left="(\d+)"/, (m, val) => 'w:left="' + (parseInt(val) + 720) + '"');
                            } else {
                                newAttrs += ' w:left="720"';
                            }
                            return '<w:ind' + newAttrs + '/>';
                        });
                    } else {
                        pPrInner += '<w:ind w:left="720"/>';
                    }
                    return '<w:pPr>' + pPrInner + '</w:pPr>';
                });
            } else {
                // It does NOT have a pPr, so inject one at the start of pInner
                pInner = '<w:pPr><w:ind w:left="720"/></w:pPr>' + pInner;
            }
            return '<w:p' + pAttrs + '>' + pInner + '</w:p>';
        });

        xml = beforeTableEnd + afterTable;
    }

    zip.file('word/document.xml', xml);
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
            // tagValue is the data value we set: either a cache key ('item_picture_1') or '-'
            if (!tagValue || tagValue === '-' || tagValue === 'empty') return dummyImageBuffer;
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
        po_number: poData.po_number || '',
        po_date: formatDate(poData.po_date),
        buyer: poData.buyer || '',
        buyer_address: poData.buyer_address || '',
        factory: poData.factory || '',
        factory_email: poData.factory_email || '',
        factory_address: poData.factory_address || '',
        // Both key variants — template may use {delivery_date} OR {po_delivery_date}
        delivery_date: formatDate(poData.po_delivery_date),
        po_delivery_date: formatDate(poData.po_delivery_date),
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
            data[`subtotal_${i}`] = (item.quantity && item.price)
                ? (Number(item.quantity) * Number(item.price)).toFixed(2)
                : '';

            // Set cache key as the value — getImage() will resolve it from imageCache
            const cacheKey = `item_picture_${i}`;
            data[cacheKey] = imageCache[cacheKey] ? cacheKey : '-';
        });


    } else {
        data['item_no_1'] = '';
        data['serial_number_1'] = '';
        data['description_1'] = 'No items';
        data['quantity_1'] = '';
        data['price_1'] = '';
        data['subtotal_1'] = '';
        data['item_picture_1'] = '-';
    }

    doc.render(data);
    return doc.getZip().generate({ type: 'nodebuffer' });
}

module.exports = { generatePODocxFromTemplate };

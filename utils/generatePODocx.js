const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, VerticalAlign, ShadingType, ImageRun } = require('docx');
const fs = require('fs');
const path = require('path');

async function generatePODocxAdvanced(poData, poItems, companyData) {
    const tableHeaderFill = "D9D9D9"; // light grey
    
    // Header section: PO Number, Date, Revision, Buying Agent
    const infoTable = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            left: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            right: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
        },
        rows: [
            new TableRow({
                children: [
                    new TableCell({ children: [new Paragraph({ text: "PO NUMBER", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: poData.po_number || '', alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "PO DATE", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: poData.po_date ? new Date(poData.po_date).toLocaleDateString('en-GB') : '', alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "REVISION\nNO.", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "Buying Agent: -\nUA Consultants", alignment: AlignmentType.CENTER })] }),
                ]
            }),
            new TableRow({
                children: [
                    new TableCell({ children: [new Paragraph({ text: "BUYER", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: poData.buyer || '', alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "FACTORY", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: poData.factory || '', alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "114 / 21A Faridabad\nHaryana, India 121001\nUAC@UAConsultants.Org\n0129 404 6038, 0129 404 6037", alignment: AlignmentType.CENTER })], columnSpan: 3 }),
                ]
            }),
            new TableRow({
                children: [
                    new TableCell({ children: [new Paragraph({ text: "DELIVERY\nADDRESS", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: poData.buyer_address || '', alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "FACTORY\nADDRESS", alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: poData.factory_address || '', alignment: AlignmentType.CENTER })] }),
                    new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })], columnSpan: 3 }),
                ]
            })
        ]
    });

    const itemHeaderRow = new TableRow({
        children: [
            new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "SERIAL\nNBR", bold: true, size: 16 })], alignment: AlignmentType.CENTER })] }),
            new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "ITEM\nNO.", bold: true, size: 16 })], alignment: AlignmentType.CENTER })] }),
            new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "PICTURE", bold: true, size: 16 })], alignment: AlignmentType.CENTER })] }),
            new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "DESCRIPTION", bold: true, size: 16 })], alignment: AlignmentType.CENTER })] }),
            new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "QTY", bold: true, size: 16 })], alignment: AlignmentType.CENTER })] }),
            new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "PRICE", bold: true, size: 16 })], alignment: AlignmentType.CENTER })] }),
            new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "SPECIAL\nCOMMENTS", bold: true, size: 16 })], alignment: AlignmentType.CENTER })] }),
        ]
    });

    const itemRows = [
        new TableRow({
            children: [
                new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "PO DELIVERY\nDATE", bold: true, size: 16 })], alignment: AlignmentType.CENTER })], columnSpan: 2 }),
                new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ text: poData.po_delivery_date ? new Date(poData.po_delivery_date).toLocaleDateString('en-GB') : '', alignment: AlignmentType.CENTER })], columnSpan: 2 }),
                new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "Terms", bold: true, size: 16 })], alignment: AlignmentType.CENTER })], columnSpan: 1 }),
                new TableCell({ shading: { fill: tableHeaderFill }, children: [new Paragraph({ children: [new TextRun({ text: "DA 60 days", bold: true, size: 16 })], alignment: AlignmentType.CENTER })], columnSpan: 2 }),
            ]
        }),
        itemHeaderRow
    ];

    if (poItems && poItems.length > 0) {
        poItems.forEach((item, index) => {
            let pictureParagraph = new Paragraph("");
            if (item.item_picture) {
                try {
                    let imagePath = '';
                    const pictureName = item.item_picture.replace(/^[/]+/, '');
                    const backendDir = 'c:/Users/apal6/OneDrive/Desktop/uac/fullFlow/f2cReact/backend';
                    
                    if (fs.existsSync(path.join(backendDir, pictureName))) {
                        imagePath = path.join(backendDir, pictureName);
                    } else if (fs.existsSync(path.join(backendDir, 'uploads', 'items', path.basename(pictureName)))) {
                        imagePath = path.join(backendDir, 'uploads', 'items', path.basename(pictureName));
                    } else {
                        const fallbackPath = 'c:/Users/apal6/OneDrive/Desktop/uac/fullFlow/LiveF2cERp/LiveF2cERp/uploads/items/' + path.basename(pictureName);
                        if (fs.existsSync(fallbackPath)) {
                            imagePath = fallbackPath;
                        }
                    }

                    if (imagePath && fs.existsSync(imagePath)) {
                        const imageBuffer = fs.readFileSync(imagePath);
                        pictureParagraph = new Paragraph({
                            children: [
                                new ImageRun({
                                    data: imageBuffer,
                                    transformation: {
                                        width: 100,
                                        height: 100
                                    }
                                })
                            ],
                            alignment: AlignmentType.CENTER
                        });
                    }
                } catch (err) {
                    console.error("Error embedding image:", err);
                }
            }

            itemRows.push(new TableRow({
                children: [
                    new TableCell({ children: [new Paragraph({ text: String(index + 1), alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ children: [new Paragraph({ text: item.item_no || '', alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ children: [pictureParagraph], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ children: [new Paragraph({ text: item.description || (item.item_name || ''), alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ children: [new Paragraph({ text: String(item.quantity || ''), alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ children: [new Paragraph({ text: item.price ? Number(item.price).toFixed(2) : '', alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }), // Special comments
                ]
            }));
        });
    } else {
        itemRows.push(new TableRow({
            children: [
                new TableCell({ children: [new Paragraph({ text: "1", alignment: AlignmentType.CENTER })] }),
                new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })] }),
                new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })] }),
                new TableCell({ children: [new Paragraph({ text: "No items", alignment: AlignmentType.CENTER })] }),
                new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })] }),
                new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })] }),
                new TableCell({ children: [new Paragraph({ text: "", alignment: AlignmentType.CENTER })] }),
            ]
        }));
    }

    const itemTable = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            left: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            right: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
        },
        rows: itemRows
    });

    const doc = new Document({
        sections: [
            {
                properties: {
                    page: {
                        margin: {
                            top: 500,
                            right: 500,
                            bottom: 500,
                            left: 500,
                        },
                    },
                },
                headers: {
                    default: undefined
                },
                footers: {
                    default: undefined
                },
                children: [
                    // Header table (UA EXIM)
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        borders: {
                            top: { style: BorderStyle.NONE, size: 0, color: "auto" },
                            bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
                            left: { style: BorderStyle.NONE, size: 0, color: "auto" },
                            right: { style: BorderStyle.NONE, size: 0, color: "auto" },
                            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
                            insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
                        },
                        rows: [
                            new TableRow({
                                children: [
                                    new TableCell({
                                        width: { size: 20, type: WidthType.PERCENTAGE },
                                        shading: { fill: "FFFFFF" },
                                        children: [
                                            new Paragraph({
                                                children: [
                                                    new TextRun({ text: "UA\nEXIM", bold: true, size: 40, color: "B2A1A1" }) // approximation
                                                ],
                                                alignment: AlignmentType.CENTER
                                            })
                                        ]
                                    }),
                                    new TableCell({
                                        width: { size: 60, type: WidthType.PERCENTAGE },
                                        shading: { fill: "C0504D" },
                                        verticalAlign: VerticalAlign.CENTER,
                                        children: [
                                            new Paragraph({
                                                children: [
                                                    new TextRun({ text: "PURCHASE ORDER", bold: true, size: 28, color: "FFFFFF" })
                                                ],
                                                alignment: AlignmentType.CENTER
                                            })
                                        ]
                                    }),
                                    new TableCell({
                                        width: { size: 20, type: WidthType.PERCENTAGE },
                                        shading: { fill: "C0504D" },
                                        verticalAlign: VerticalAlign.CENTER,
                                        children: [
                                            new Paragraph({
                                                children: [
                                                    new TextRun({ text: "UA EXIM LLC\n23110 San Nicholas Place\nKaty Texas 77494", size: 14, color: "FFFFFF" })
                                                ],
                                                alignment: AlignmentType.CENTER
                                            })
                                        ]
                                    })
                                ]
                            })
                        ]
                    }),
                    new Paragraph({ text: "", spacing: { after: 200 } }),
                    
                    infoTable,
                    
                    new Paragraph({ text: "", spacing: { after: 200 } }),
                    
                    new Paragraph({
                        children: [
                            new TextRun({ text: "Dear Sir,", bold: true, italics: true, size: 18 }),
                        ],
                        spacing: { after: 0 }
                    }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "On behalf of the Consignee we are pleased to place the following order with you:", bold: true, italics: true, size: 18 }),
                        ],
                        spacing: { after: 200 }
                    }),

                    itemTable,
                    
                    new Paragraph({ text: "", spacing: { after: 400 } }),
                ],
            }
        ]
    });

    return await Packer.toBuffer(doc);
}

module.exports = { generatePODocxAdvanced };

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const COMPANY = {
  name: "SHREE ASHTAVINAYAK THEATRE VENTURES PVT LTD",
  addressLines: ["Gala No. 2, Mistry Industrial", "Complex, Hanuman Nagar, Radisson", "Hotel, MIDC Andheri East- 400093"],
  city: "Mumbai 400093",
  state: "Maharashtra",
  country: "India",
  stateCode: "27",
  phone: "9819907902",
  gstin: "27ABCCS9803M1ZU",
  website: "http://www.thetheatreproject.co.in/",
  email: "contact@thetheatreproject.co.in",
};

// Indian state name -> GST state code, for the "State Code" line under the
// shipping address. Extend this list if orders start coming from states not
// covered here.
const STATE_CODES = {
  "andhra pradesh": "37", "arunachal pradesh": "12", assam: "18", bihar: "10",
  chhattisgarh: "22", goa: "30", gujarat: "24", haryana: "06",
  "himachal pradesh": "02", jharkhand: "20", karnataka: "29", kerala: "32",
  "madhya pradesh": "23", maharashtra: "27", manipur: "14", meghalaya: "17",
  mizoram: "15", nagaland: "13", odisha: "21", punjab: "03", rajasthan: "08",
  sikkim: "11", "tamil nadu": "33", telangana: "36", tripura: "16",
  "uttar pradesh": "09", uttarakhand: "05", "west bengal": "19",
  delhi: "07", "jammu and kashmir": "01", ladakh: "38", chandigarh: "04",
  puducherry: "34",
};

function stateCode(stateName) {
  if (!stateName) return "";
  return STATE_CODES[stateName.trim().toLowerCase()] || "";
}

/**
 * Generates a GST tax invoice PDF matching TTP's real invoice format.
 *
 * order: {
 *   orderId, createdAt, customerName,
 *   shippingAddress: { address1, address2, city, province, zip, country },
 *   totalPrice, financialStatus, // 'paid' -> "prepaid", else "COD"
 * }
 * lineItems: [{ title, sku, quantity, price, hsn, igstPercent }]
 *   igstPercent defaults to 0 (matches the reference invoice, food items at
 *   0% GST) — pass a value per line item if some products carry GST.
 */
function generateInvoicePdf(order, lineItems, outputDir) {
  const fileName = `invoice_${order.orderId.replace("#", "")}_${Date.now()}.pdf`;
  const filePath = path.join(outputDir, fileName);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(fs.createWriteStream(filePath));

  const pageLeft = 40;
  const pageRight = doc.page.width - 40;
  const fullWidth = pageRight - pageLeft;

  // ---- Logo ----
  const logoPath = path.join(__dirname, "assets", "logo.png");
  if (fs.existsSync(logoPath)) {
    const logoSize = 90;
    doc.image(logoPath, (doc.page.width - logoSize) / 2, doc.y, { width: logoSize });
    doc.y += logoSize + 10;
  } else {
    doc.moveDown(1);
  }

  // ---- Title (vertically centered between the two rules) ----
  const titleTop = doc.y;
  doc.moveTo(pageLeft, titleTop).lineTo(pageRight, titleTop).stroke();
  const titlePadding = 14;
  doc.y = titleTop + titlePadding;
  doc.font("Helvetica").fontSize(22).text("TAX INVOICE", { align: "center" });
  doc.y = doc.y + titlePadding;
  doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
  doc.moveDown(1);

  // ---- Three-column header: SHIPPING ADDRESS | SOLD BY | INVOICE DETAILS ----
  const col1X = pageLeft;
  const col2X = pageLeft + fullWidth * 0.34;
  const col3X = pageLeft + fullWidth * 0.64;
  const colTop = doc.y;
  const colWidth1 = col2X - col1X - 15;
  const colWidth2 = col3X - col2X - 15;
  const colWidth3 = pageRight - col3X;

  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("SHIPPING ADDRESS:", col1X, colTop, { width: colWidth1 });
  doc.text("SOLD BY:", col2X, colTop, { width: colWidth2 });
  doc.text("INVOICE DETAILS:", col3X, colTop, { width: colWidth3 });

  let y1 = colTop + 16;
  doc.font("Helvetica").fontSize(9);
  const addr = order.shippingAddress || {};
  const shippingLines = [
    order.customerName,
    addr.address1,
    addr.address2,
    [addr.city, addr.zip].filter(Boolean).join(" "),
    addr.province,
    addr.country || "India",
    `State Code : ${stateCode(addr.province)}`,
  ].filter(Boolean);
  for (const line of shippingLines) {
    doc.text(line, col1X, y1, { width: colWidth1 });
    y1 = doc.y + 2;
  }

  let y2 = colTop + 16;
  const soldByLines = [
    COMPANY.name,
    ...COMPANY.addressLines,
    COMPANY.city,
    COMPANY.state,
    COMPANY.country,
    `State Code : ${COMPANY.stateCode}`,
    `Ph: ${COMPANY.phone}`,
    `GSTIN No. ${COMPANY.gstin}`,
    "Website:",
    COMPANY.website,
    "Email:",
    COMPANY.email,
  ];
  for (const line of soldByLines) {
    doc.text(line, col2X, y2, { width: colWidth2, align: "right" });
    y2 = doc.y + 2;
  }

  let y3 = colTop + 16;
  const paymentMethod = order.financialStatus === "paid" ? "prepaid" : "COD";
  const invoiceDetailRows = [
    ["INVOICE NO.", order.orderId.replace("#", "")],
    ["INVOICE DATE", formatDate(order.createdAt)],
    ["ORDER NO.", order.orderId.replace("#", "")],
    ["ORDER DATE", formatDate(order.createdAt)],
    ["CHANNEL", "The Theatre Project (Shopify)"],
    ["SHIPPED BY", ""],
    ["AWB NO.", ""],
    ["PAYMENT METHOD", paymentMethod],
    ["REMARK", ""],
  ];
  doc.font("Helvetica-Bold").fontSize(9);
  for (const [label, value] of invoiceDetailRows) {
    doc.text(label, col3X, y3, { width: colWidth3, continued: false });
    const labelHeight = doc.heightOfString(label, { width: colWidth3 });
    doc.font("Helvetica").text(`: ${value}`, col3X, y3 + labelHeight, { width: colWidth3 });
    doc.font("Helvetica-Bold");
    y3 = doc.y + 4;
  }

  const headerBottom = Math.max(y1, y2, y3) + 10;

  // Vertical dividers between the three columns
  doc.moveTo(col2X - 8, colTop).lineTo(col2X - 8, headerBottom).dash(2, { space: 2 }).stroke();
  doc.undash();
  doc.moveTo(col3X - 8, colTop).lineTo(col3X - 8, headerBottom).stroke();

  doc.y = headerBottom + 10;
  doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
  doc.moveDown(0.5);

  // ---- Item table ----
  // Fixed pixel widths for the numeric columns (they don't need to scale
  // with page width), computed left-to-right with a small gap between each
  // so nothing overlaps — the product name column absorbs whatever space
  // is left over.
  const gap = 4;
  const snoW = 20, hsnW = 35, qtyW = 22, priceW = 48, discountW = 42, taxableW = 55, igstW = 58, totalW = 55;
  const fixedTotal = snoW + hsnW + qtyW + priceW + discountW + taxableW + igstW + totalW + gap * 8;
  const productW = fullWidth - fixedTotal;

  const snoX = pageLeft;
  const productX = snoX + snoW + gap;
  const hsnX = productX + productW + gap;
  const qtyX = hsnX + hsnW + gap;
  const priceX = qtyX + qtyW + gap;
  const discountX = priceX + priceW + gap;
  const taxableX = discountX + discountW + gap;
  const igstX = taxableX + taxableW + gap;
  const totalX = igstX + igstW + gap;
  const tableRight = totalX + totalW;

  let ty = doc.y;
  doc.font("Helvetica-Bold").fontSize(7);
  doc.text("S.NO.", snoX, ty, { width: snoW });
  doc.text("PRODUCT NAME", productX, ty, { width: productW });
  doc.text("HSN", hsnX, ty, { width: hsnW });
  doc.text("QTY", qtyX, ty, { width: qtyW });
  doc.text("UNIT PRICE", priceX, ty, { width: priceW });
  doc.text("UNIT", discountX, ty, { width: discountW });
  doc.text("TAXABLE", taxableX, ty, { width: taxableW, align: "right" });
  doc.text("IGST", igstX, ty, { width: igstW, align: "right" });
  doc.text("TOTAL", totalX, ty, { width: totalW, align: "right" });
  ty += 9;
  doc.text("DISCOUNT", discountX, ty, { width: discountW });
  doc.text("VALUE", taxableX, ty, { width: taxableW, align: "right" });
  doc.text("(Value | %)", igstX, ty, { width: igstW, align: "right" });
  doc.text("(Incl. GST)", totalX, ty, { width: totalW, align: "right" });
  ty += 14;
  doc.moveTo(pageLeft, ty).lineTo(pageRight, ty).stroke();
  ty += 8;

  let netTotal = 0;
  doc.font("Helvetica").fontSize(8);

  lineItems.forEach((item, idx) => {
    if (ty > doc.page.height - 150) {
      doc.addPage();
      ty = 40;
    }

    const rowTop = ty;
    const unitPrice = parseFloat(item.price) || 0;
    const unitDiscount = parseFloat(item.unitDiscount) || 0;
    const taxableValue = round2((unitPrice - unitDiscount) * item.quantity);
    const igstPercent = parseFloat(item.igstPercent) || 0;
    const igstValue = round2(taxableValue * (igstPercent / 100));
    const total = round2(taxableValue + igstValue);
    netTotal += total;

    doc.font("Helvetica").fontSize(8).text(String(idx + 1), snoX, rowTop, { width: snoW });

    doc.font("Helvetica-Bold").fontSize(8);
    doc.text(item.title || "", productX, rowTop, { width: productW });
    const titleHeight = doc.heightOfString(item.title || "", { width: productW });
    doc.font("Helvetica").fontSize(7.5);
    doc.text(`SKU : ${item.sku || ""}`, productX, rowTop + titleHeight + 2, { width: productW });

    doc.font("Helvetica").fontSize(8);
    doc.text(item.hsn || "", hsnX, rowTop, { width: hsnW });
    doc.text(String(item.quantity), qtyX, rowTop, { width: qtyW });
    doc.text(`Rs. ${unitPrice.toFixed(2)}`, priceX, rowTop, { width: priceW });
    doc.text(unitDiscount.toFixed(2), discountX, rowTop, { width: discountW });
    doc.text(taxableValue.toFixed(2), taxableX, rowTop, { width: taxableW, align: "right" });
    doc.text(`${igstValue.toFixed(2)} | ${igstPercent.toFixed(2)}`, igstX, rowTop, { width: igstW, align: "right" });
    doc.text(total.toFixed(2), totalX, rowTop, { width: totalW, align: "right" });

    const rowHeight = Math.max(titleHeight + 12, 20);
    ty = rowTop + rowHeight + 6;
  });

  doc.moveTo(pageLeft, ty).lineTo(pageRight, ty).stroke();
  ty += 10;

  doc.font("Helvetica-Bold").fontSize(11);
  doc.text("NET TOTAL (In Value)", pageLeft, ty, { width: fullWidth * 0.7 });
  doc.text(
    `Rs. ${(order.totalPrice !== undefined && order.totalPrice !== null ? parseFloat(order.totalPrice) : netTotal).toFixed(2)}`,
    pageLeft,
    ty,
    { width: fullWidth, align: "right" }
  );
  ty += 25;
  doc.moveTo(pageLeft, ty).lineTo(pageRight, ty).stroke();
  ty += 10;

  doc.font("Helvetica").fontSize(8);
  doc.text("Whether tax is payable under reverse charge- No", pageLeft, ty, { width: fullWidth, align: "right" });
  ty += 30;

  // ---- Signature box ----
  const sigBoxW = 100, sigBoxH = 60;
  doc.rect(pageLeft, ty, sigBoxW, sigBoxH).stroke();
  const sigPath = path.join(__dirname, "assets", "signature.png");
  if (fs.existsSync(sigPath)) {
    // Fit the signature inside the box with a small margin, preserving aspect ratio
    doc.image(sigPath, pageLeft + 5, ty + 5, { fit: [sigBoxW - 10, sigBoxH - 10] });
  }
  ty += sigBoxH + 10;
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("Authorized Signature for", pageLeft, ty, { width: 200 });
  doc.text(COMPANY.name, pageLeft, doc.y, { width: 200 });

  doc.end();

  return filePath;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

module.exports = { generateInvoicePdf };

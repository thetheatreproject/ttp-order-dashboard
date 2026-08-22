const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

// Fixed company details (from the reference challan)
const COMPANY = {
  cin: "U7499MH2019PTC33358",
  name: "SHREE ASHTAVINAYAK THEATRE VENTURES PVT. LTD",
  gst: "23ABCCS9803M1Z2",
  address: "WH-MUM: Gala No. 2, Mistry Industrial Complex, Hanuman Nagar, Radisson Hotel, MIDC",
};

/**
 * Generates a challan PDF matching the reference "3674_challan.pdf" layout.
 *
 * order: {
 *   orderId, createdAt, customerName,
 *   shippingAddress: { address1, address2, city, province, zip },
 *   orderType,          // e.g. "New Order" / "Repeat Order"
 *   totalOrdersCount,   // "TOTAL NUMBER OF ORDERS" field
 *   logisticPartner,    // optional, usually filled by hand
 *   challanNo,          // optional, usually filled by hand
 *   totalPrice,         // actual order total from Shopify — used for the TOTAL row
 * }
 * enrichedLineItems: [{ title, grammage, mrp, quantity, batchNo, mfgDate }]
 */
function generateChallanPdf(order, enrichedLineItems, outputDir) {
  const fileName = `challan_${order.orderId.replace("#", "")}_${Date.now()}.pdf`;
  const filePath = path.join(outputDir, fileName);

  const doc = new PDFDocument({ size: "A4", margin: 20 });
  doc.pipe(fs.createWriteStream(filePath));

  const pageLeft = 20;
  const pageRight = 575; // A4 width 595 - margin 20
  const fullWidth = pageRight - pageLeft;

  // Column boundaries for the top info block (label | value | rightLabel | rightValue)
  const c1 = pageLeft;
  const c2 = pageLeft + fullWidth * 0.26;
  const c3 = pageLeft + fullWidth * 0.735;
  const c4 = pageLeft + fullWidth * 0.845;

  const rowH = 22;
  let y = 20;

  // Writes text on a single line, auto-shrinking the font until it fits the
  // given width (down to minSize), instead of wrapping and overlapping rows.
  function fitText(text, x, yy, w, opts = {}) {
    const str = text || "";
    const font = opts.font || "Helvetica";
    const maxSize = opts.fontSize || 9;
    const minSize = opts.minSize || 6;
    let size = maxSize;
    doc.font(font);
    while (size > minSize && doc.fontSize(size).widthOfString(str) > w - 8) {
      size -= 0.5;
    }
    doc.fontSize(size);
    const textHeight = doc.currentLineHeight();
    const vPad = Math.max(0, (rowH - textHeight) / 2) - 2;
    doc.text(str, x + 4, yy + vPad, { width: w - 8, align: opts.align || "left", lineBreak: false });
  }

  function hLine(yy) {
    doc.moveTo(pageLeft, yy).lineTo(pageRight, yy).stroke();
  }
  function vLine(x, y1, y2) {
    doc.moveTo(x, y1).lineTo(x, y2).stroke();
  }

  doc.lineWidth(0.75);

  // ---- Row 1: CIN | Company Name | CHALLAN NO | value ----
  fitText(`CIN: ${COMPANY.cin}`, c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(COMPANY.name, c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 10, align: "center" });
  fitText("CHALLAN NO :", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.challanNo || "", c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 2: GST | Address (spans to end) ----
  fitText(`GST : ${COMPANY.gst}`, c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(COMPANY.address, c2, y, pageRight - c2, {
    font: "Helvetica-Oblique",
    fontSize: 8,
    align: "center",
  });
  y += rowH;

  // ---- Row 3: CONSIGNEE NAME | value | ORDER | date ----
  fitText("CONSIGNEE NAME :", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.customerName || "", c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 9 });
  fitText("ORDER", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(formatDate(order.createdAt), c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 4: CONSIGNEE LOCATION | value | DISPATCH | value ----
  const addr = order.shippingAddress || {};
  const addrLine = [addr.address1, addr.address2, addr.city, addr.zip ? `- ${addr.zip}` : ""]
    .filter(Boolean)
    .join(", ")
    .replace(", -", " -");
  fitText("CONSIGNEE LOCATION:", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(addrLine, c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 9, minSize: 6 });
  fitText("DISPATCH", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.dispatch || "", c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 5: CONSIGNEE STATE | value | VERIFIED BY | value ----
  fitText("CONSIGNEE STATE:", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(addr.province || "", c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 9 });
  fitText("VERIFIED BY", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.verifiedBy || "", c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 6: TOTAL NUMBER OF ORDERS | value | ORDER TYPE | value ----
  fitText("TOTAL NUMBER OF ORDERS:", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(String(order.totalOrdersCount ?? ""), c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 9 });
  fitText("ORDER TYPE", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.orderType || "", c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 7: LOGISTIC PARTNER (spans full width) ----
  fitText("LOGISTIC PARTNER :", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.logisticPartner || "", c2, y, pageRight - c2, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 8: ORDER NO (spans full width) ----
  fitText("ORDER NO:", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.orderId.replace("#", ""), c2, y, pageRight - c2, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // Draw horizontal + vertical lines for the info block (rows 1-8)
  const infoTop = 20;
  for (let ry = infoTop; ry <= y; ry += rowH) hLine(ry);
  vLine(c1, infoTop, y);
  vLine(c2, infoTop, y - rowH * 2); // ends before LOGISTIC PARTNER/ORDER NO rows (full width)
  vLine(c3, infoTop, y - rowH * 2);
  vLine(c4, infoTop, y - rowH * 2);
  vLine(pageRight, infoTop, y);

  // ---- Item table header ----
  const tCols = {
    desc: pageLeft,
    grammage: pageLeft + fullWidth * 0.42,
    mrp: pageLeft + fullWidth * 0.56,
    batch: pageLeft + fullWidth * 0.65,
    mfg: pageLeft + fullWidth * 0.8,
    qty: pageLeft + fullWidth * 0.9,
  };
  const tableHeaderTop = y;
  fitText("DESCRIPTION OF GOODS", tCols.desc, y, tCols.grammage - tCols.desc, {
    font: "Helvetica-Bold",
    fontSize: 8,
  });
  fitText("GRAMMAGE", tCols.grammage, y, tCols.mrp - tCols.grammage, {
    font: "Helvetica-Bold",
    fontSize: 8,
    align: "center",
  });
  fitText("MRP", tCols.mrp, y, tCols.batch - tCols.mrp, {
    font: "Helvetica-Bold",
    fontSize: 8,
    align: "center",
  });
  fitText("BATCH NO", tCols.batch, y, tCols.mfg - tCols.batch, {
    font: "Helvetica-Bold",
    fontSize: 8,
    align: "center",
  });
  fitText("MFG DATE", tCols.mfg, y, tCols.qty - tCols.mfg, {
    font: "Helvetica-Bold",
    fontSize: 8,
    align: "center",
  });
  fitText("QUANTITY", tCols.qty, y, pageRight - tCols.qty, {
    font: "Helvetica-Bold",
    fontSize: 8,
    align: "center",
  });
  y += rowH;

  // ---- Item rows (pad to at least 14 rows like the reference, blank rows included) ----
  const minRows = Math.max(enrichedLineItems.length, 14);
  let computedTotal = 0;
  for (let i = 0; i < minRows; i++) {
    const item = enrichedLineItems[i];
    if (item) {
      const mrpNum = parseFloat(item.mrp) || 0;
      computedTotal += mrpNum * item.quantity;
      fitText(item.title || item.productName || "", tCols.desc, y, tCols.grammage - tCols.desc, {
        font: "Helvetica",
        fontSize: 8,
      });
      fitText(item.grammage || "", tCols.grammage, y, tCols.mrp - tCols.grammage, {
        font: "Helvetica",
        fontSize: 8,
        align: "center",
      });
      fitText(item.mrp ? String(item.mrp) : "", tCols.mrp, y, tCols.batch - tCols.mrp, {
        font: "Helvetica",
        fontSize: 8,
        align: "center",
      });
      fitText(item.batchNo || "", tCols.batch, y, tCols.mfg - tCols.batch, {
        font: "Helvetica",
        fontSize: 8,
        align: "center",
      });
      fitText(item.mfgDate || "", tCols.mfg, y, tCols.qty - tCols.mfg, {
        font: "Helvetica",
        fontSize: 8,
        align: "center",
      });
      fitText(String(item.quantity), tCols.qty, y, pageRight - tCols.qty, {
        font: "Helvetica",
        fontSize: 8,
        align: "center",
      });
    }
    y += rowH;
    if (y > 760) {
      doc.addPage();
      y = 40;
    }
  }

  // Table borders
  for (let ry = tableHeaderTop; ry <= y; ry += rowH) hLine(ry);
  [tCols.desc, tCols.grammage, tCols.mrp, tCols.batch, tCols.mfg, tCols.qty, pageRight].forEach((x) =>
    vLine(x, tableHeaderTop, y)
  );

  // ---- Footer: Terms | TOTAL | amount ----
  // Prefer the real Shopify order total (selling price) over a recomputed
  // MRP*qty sum, since MRP on the label often differs from the selling price.
  const grandTotal =
    order.totalPrice !== undefined && order.totalPrice !== null
      ? parseFloat(order.totalPrice)
      : computedTotal;

  const footTop = y;
  const footRowH = rowH + 10;
  const footTotalLabelX = pageLeft + fullWidth * 0.62;
  const footTotalValueX = pageLeft + fullWidth * 0.72;
  fitText(`*Terms & Condition Apply by ${COMPANY.name}`, pageLeft, y, footTotalLabelX - pageLeft, {
    font: "Helvetica-Oblique",
    fontSize: 8,
    minSize: 5,
  });
  fitText("TOTAL", footTotalLabelX, y, footTotalValueX - footTotalLabelX, {
    font: "Helvetica-Bold",
    fontSize: 9,
  });
  fitText(`Rs ${grandTotal.toFixed(2)}`, footTotalValueX, y, pageRight - footTotalValueX, {
    font: "Helvetica-Bold",
    fontSize: 11,
  });
  y += footRowH;

  // ---- CHECKED BY row ----
  fitText("CHECKED BY", pageLeft, y, footTotalLabelX - pageLeft, { font: "Helvetica-Bold", fontSize: 8 });
  y += rowH;

  hLine(footTop);
  hLine(footTop + footRowH);
  hLine(y);
  vLine(pageLeft, footTop, y);
  vLine(footTotalLabelX, footTop, footTop + footRowH);
  vLine(footTotalValueX, footTop, footTop + footRowH);
  vLine(pageRight, footTop, y);

  doc.end();

  return filePath;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

module.exports = { generateChallanPdf };

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const COMPANY = {
  cin: "U7499MH2019PTC33358",
  name: "SHREE ASHTAVINAYAK THEATRE VENTURES PVT. LTD",
  gst: "23ABCCS9803M1Z2",
  address: "WH-MUM: Gala No. 2, Mistry Industrial Complex, Hanuman Nagar, Radisson Hotel, MIDC",
};

/**
 * Generates a challan PDF matching the reference challan layout, in
 * landscape orientation.
 */
function generateChallanPdf(order, enrichedLineItems, outputDir) {
  return new Promise((resolve, reject) => {
    const fileName = `challan_${order.orderId.replace("#", "")}_${Date.now()}.pdf`;
    const filePath = path.join(outputDir, fileName);

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 20 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

  const pageLeft = 20;
  const pageRight = doc.page.width - 20;
  const pageBottom = doc.page.height - 20;
  const fullWidth = pageRight - pageLeft;

  const c1 = pageLeft;
  const c2 = pageLeft + fullWidth * 0.17; // tighter label column, was too wide in landscape
  const c3 = pageLeft + fullWidth * 0.735;
  const c4 = pageLeft + fullWidth * 0.845;

  const rowH = 20;
  let y = 20;

  function fitText(text, x, yy, w, opts = {}) {
    const str = text || "";
    const font = opts.font || "Helvetica";
    const maxSize = opts.fontSize || 9;
    const minSize = opts.minSize || 6;
    const available = w - 8;
    const boxHeight = opts.rowHeight || rowH;
    let size = maxSize;
    doc.font(font);
    while (size > minSize && doc.fontSize(size).widthOfString(str) > available) {
      size -= 0.5;
    }
    doc.fontSize(size);

    let finalStr = str;
    if (doc.widthOfString(finalStr) > available) {
      while (finalStr.length > 1 && doc.widthOfString(finalStr + "...") > available) {
        finalStr = finalStr.slice(0, -1);
      }
      finalStr = finalStr.length > 1 ? finalStr + "..." : finalStr;
    }

    const textHeight = doc.currentLineHeight();
    const vPad = Math.max(0, (boxHeight - textHeight) / 2);
    doc.text(finalStr, x + 4, yy + vPad, { width: available, align: opts.align || "left", lineBreak: false });
  }

  function hLine(yy, xStart = pageLeft, xEnd = pageRight) {
    doc.moveTo(xStart, yy).lineTo(xEnd, yy).stroke();
  }
  function vLineSeg(x, y1, y2) {
    doc.moveTo(x, y1).lineTo(x, y2).stroke();
  }

  doc.lineWidth(0.75);

  // Each header row explicitly declares which internal vertical dividers it
  // has (besides the outer pageLeft/pageRight edges), since rows differ:
  // some are 4-column (label|value|label|value), some are 2-column
  // (label|value spanning the rest), avoiding the earlier bug where a
  // single continuous vertical line was drawn across rows with different
  // structures.
  const rowTops = [];

  function startRow(dividers) {
    rowTops.push({ top: y, dividers });
  }

  // ---- Row 1: CIN | Company Name | CHALLAN NO | value ----
  startRow([c2, c3, c4]);
  fitText(`CIN: ${COMPANY.cin}`, c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(COMPANY.name, c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 10, align: "center" });
  fitText("CHALLAN NO :", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.challanNo || "", c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 2: GST | Company Address (spans full remaining width) ----
  startRow([c2]);
  fitText(`GST : ${COMPANY.gst}`, c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(COMPANY.address, c2, y, pageRight - c2, { font: "Helvetica-Oblique", fontSize: 8, align: "center" });
  y += rowH;

  // ---- Row 3: CONSIGNEE NAME | value | ORDER | date ----
  startRow([c2, c3, c4]);
  fitText("CONSIGNEE NAME :", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.customerName || "", c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 9 });
  fitText("ORDER", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(formatDate(order.createdAt), c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 4: CONSIGNEE NUMBER | value (spans full remaining width) ----
  startRow([c2]);
  fitText("CONSIGNEE NUMBER :", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.customerPhone || "", c2, y, pageRight - c2, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 5: CONSIGNEE LOCATION | value | DISPATCH | value ----
  startRow([c2, c3, c4]);
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

  // ---- Row 6: CONSIGNEE STATE | value | VERIFIED BY | value ----
  startRow([c2, c3, c4]);
  fitText("CONSIGNEE STATE:", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(addr.province || "", c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 9 });
  fitText("VERIFIED BY", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.verifiedBy || "", c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 7: TOTAL NUMBER OF ORDERS | value | ORDER TYPE | value ----
  startRow([c2, c3, c4]);
  fitText("TOTAL NUMBER OF ORDERS:", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(String(order.totalOrdersCount ?? ""), c2, y, c3 - c2, { font: "Helvetica-Bold", fontSize: 9 });
  fitText("ORDER TYPE", c3, y, c4 - c3, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.orderType || "", c4, y, pageRight - c4, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 8: LOGISTIC PARTNER | value (spans full remaining width) ----
  startRow([c2]);
  fitText("LOGISTIC PARTNER :", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.logisticPartner || "", c2, y, pageRight - c2, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // ---- Row 9: ORDER NO | value (spans full remaining width) ----
  startRow([c2]);
  fitText("ORDER NO:", c1, y, c2 - c1, { font: "Helvetica-Bold", fontSize: 8 });
  fitText(order.orderId.replace("#", ""), c2, y, pageRight - c2, { font: "Helvetica-Bold", fontSize: 9 });
  y += rowH;

  // Draw horizontal lines for every row boundary, and vertical dividers
  // per-row based on each row's own declared structure.
  const infoTop = 20;
  for (let ry = infoTop; ry <= y; ry += rowH) hLine(ry);
  vLineSeg(pageLeft, infoTop, y);
  vLineSeg(pageRight, infoTop, y);
  for (const row of rowTops) {
    for (const divider of row.dividers) {
      vLineSeg(divider, row.top, row.top + rowH);
    }
  }

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
  fitText("DESCRIPTION OF GOODS", tCols.desc, y, tCols.grammage - tCols.desc, { font: "Helvetica-Bold", fontSize: 8 });
  fitText("GRAMMAGE", tCols.grammage, y, tCols.mrp - tCols.grammage, { font: "Helvetica-Bold", fontSize: 8, align: "center" });
  fitText("MRP", tCols.mrp, y, tCols.batch - tCols.mrp, { font: "Helvetica-Bold", fontSize: 8, align: "center" });
  fitText("BATCH NO", tCols.batch, y, tCols.mfg - tCols.batch, { font: "Helvetica-Bold", fontSize: 8, align: "center" });
  fitText("MFG DATE", tCols.mfg, y, tCols.qty - tCols.mfg, { font: "Helvetica-Bold", fontSize: 8, align: "center" });
  fitText("QUANTITY", tCols.qty, y, pageRight - tCols.qty, { font: "Helvetica-Bold", fontSize: 8, align: "center" });
  y += rowH;

  // ---- Item rows ----
  let computedTotal = 0;
  const footerReserve = rowH * 2 + 18;
  const minRowsTotal = Math.max(enrichedLineItems.length, 10);
  let itemIndex = 0;
  let pageTableTop = tableHeaderTop;

  while (itemIndex < minRowsTotal) {
    const item = enrichedLineItems[itemIndex];
    if (item) {
      const mrpNum = parseFloat(item.mrp) || 0;
      computedTotal += mrpNum * item.quantity;
      fitText(item.title || item.productName || "", tCols.desc, y, tCols.grammage - tCols.desc, { font: "Helvetica", fontSize: 8 });
      fitText(item.grammage || "", tCols.grammage, y, tCols.mrp - tCols.grammage, { font: "Helvetica", fontSize: 8, align: "center" });
      fitText(item.mrp ? String(item.mrp) : "", tCols.mrp, y, tCols.batch - tCols.mrp, { font: "Helvetica", fontSize: 8, align: "center" });
      fitText(item.batchNo || "", tCols.batch, y, tCols.mfg - tCols.batch, { font: "Helvetica", fontSize: 8, align: "center" });
      fitText(item.mfgDate || "", tCols.mfg, y, tCols.qty - tCols.mfg, { font: "Helvetica", fontSize: 8, align: "center" });
      fitText(String(item.quantity), tCols.qty, y, pageRight - tCols.qty, { font: "Helvetica", fontSize: 8, align: "center" });
    }
    y += rowH;
    itemIndex++;

    if (y > pageBottom - footerReserve && itemIndex < minRowsTotal) {
      for (let ry = pageTableTop; ry <= y; ry += rowH) hLine(ry);
      [tCols.desc, tCols.grammage, tCols.mrp, tCols.batch, tCols.mfg, tCols.qty, pageRight].forEach((x) => vLineSeg(x, pageTableTop, y));
      doc.addPage();
      y = 20;
      pageTableTop = y;
    }
  }

  for (let ry = pageTableTop; ry <= y; ry += rowH) hLine(ry);
  [tCols.desc, tCols.grammage, tCols.mrp, tCols.batch, tCols.mfg, tCols.qty, pageRight].forEach((x) => vLineSeg(x, pageTableTop, y));

  // ---- Footer: Terms | TOTAL | amount ----
  const grandTotal =
    order.totalPrice !== undefined && order.totalPrice !== null ? parseFloat(order.totalPrice) : computedTotal;

  const footTop = y;
  const footRowH = rowH + 10;
  const footTotalLabelX = pageLeft + fullWidth * 0.62;
  const footTotalValueX = pageLeft + fullWidth * 0.72;
  fitText(`*Terms & Condition Apply by ${COMPANY.name}`, pageLeft, y, footTotalLabelX - pageLeft, { font: "Helvetica-Oblique", fontSize: 8, minSize: 5, rowHeight: footRowH });
  fitText("TOTAL", footTotalLabelX, y, footTotalValueX - footTotalLabelX, { font: "Helvetica-Bold", fontSize: 9, rowHeight: footRowH });
  fitText(`Rs ${grandTotal.toFixed(2)}`, footTotalValueX, y, pageRight - footTotalValueX, { font: "Helvetica-Bold", fontSize: 11, rowHeight: footRowH });
  y += footRowH;

  fitText("CHECKED BY", pageLeft, y, footTotalLabelX - pageLeft, { font: "Helvetica-Bold", fontSize: 8 });
  y += rowH;

  hLine(footTop);
  hLine(footTop + footRowH);
  hLine(y);
  vLineSeg(pageLeft, footTop, y);
  vLineSeg(footTotalLabelX, footTop, footTop + footRowH);
  vLineSeg(footTotalValueX, footTop, footTop + footRowH);
  vLineSeg(pageRight, footTop, y);

  doc.end();

  stream.on("finish", () => resolve(filePath));
  stream.on("error", reject);
  });
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

module.exports = { generateChallanPdf };

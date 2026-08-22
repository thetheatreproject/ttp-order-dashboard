const { google } = require("googleapis");

// The 5 category tabs from your master file. Same column layout in each
// (Popcorn has one extra column, EAN Code, handled via header lookup below
// rather than fixed indices, so it doesn't break the shared logic).
const CATEGORY_TABS = [
  "Popcorn",
  "Kettle Cooked Chips",
  "Air Popped Chips",
  "Krinkle Cut Chips",
  "Nachos",
];

// A separate tab mapping what's actually SOLD (e.g. "Cheddar Cheese Gourmet
// Popcorn Pack of 10" on Shopify) to what's TRACKED in the category tabs.
// Since the same Base Product Name can appear at multiple grammage/MRP
// variants in a category tab (e.g. 30g/Rs30 and 60g/Rs60), Grammage and MRP
// are included here too, to pin down the exact variant being sold. This tab
// needs to be created manually in the master sheet with these exact column
// headers:
//   Website Product Name | Base Product Name | Grammage | MRP | Units Per Pack
const MAPPING_TAB = "Website Product Mapping";

let sheetsClientPromise = null;

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    // On Render (and similar hosts), the service account JSON is passed as
    // an environment variable's raw content rather than a file on disk.
    // Falls back to a file path for local development.
    const authOptions = { scopes: ["https://www.googleapis.com/auth/spreadsheets"] };
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else {
      authOptions.keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
    }
    const auth = new google.auth.GoogleAuth(authOptions);
    sheetsClientPromise = auth.getClient().then((client) => google.sheets({ version: "v4", auth: client }));
  }
  return sheetsClientPromise;
}

// Column headers we care about, matched by name (not fixed index) so the
// extra EAN Code column on the Popcorn tab doesn't shift anything.
const COLUMNS = {
  productType: "Product Type",
  productName: "Product Name",
  mrp: "Product Mrp",
  grammage: "Product Grammage",
  batchNumber: "Batch Number",
  mfd: "MFD",
  exp: "EXP",
  quantity: "Quantity",
  priority: "Priority",
};

/**
 * Reads one category tab and returns rows as objects, keyed by column name
 * (robust to the Popcorn tab's extra EAN Code column) plus the actual sheet
 * row number so we can write deductions back to the right cell.
 */
async function loadTab(tabName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${tabName}'!A1:Z500`,
  });

  const rows = res.data.values || [];
  const header = rows[0] || [];
  const colIndex = {};
  for (const [key, label] of Object.entries(COLUMNS)) {
    colIndex[key] = header.indexOf(label);
  }

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const productName = colIndex.productName >= 0 ? row[colIndex.productName] : null;
    if (!productName) continue; // skip blank rows

    items.push({
      tab: tabName,
      rowNumber: i + 1, // 1-indexed to match sheet row numbers
      productType: row[colIndex.productType] || "",
      productName: productName.trim(),
      mrp: row[colIndex.mrp] || "",
      grammage: row[colIndex.grammage] || "",
      batchNumber: row[colIndex.batchNumber] || "",
      mfd: row[colIndex.mfd] || "",
      exp: row[colIndex.exp] || "",
      quantity: parseInt(row[colIndex.quantity], 10) || 0,
      priority: parseInt(row[colIndex.priority], 10) || 999999,
      quantityColLetter: colIndex.quantity >= 0 ? colLetter(colIndex.quantity) : null,
    });
  }
  return items;
}

function colLetter(index) {
  // 0 -> A, 1 -> B, ...
  let letter = "";
  let n = index;
  do {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letter;
}

/**
 * Finds every batch row across all category tabs matching a product name
 * exactly (case-insensitive, trimmed), sorted by Priority ascending — the
 * order batches should be used in. If grammage/mrp are provided, also
 * filters to that exact variant — needed since the same product name can
 * appear at multiple grammage/MRP combinations in a category tab.
 */
async function findProductBatches(productName, grammage = null, mrp = null) {
  const target = productName.trim().toLowerCase();
  const allTabs = await Promise.all(CATEGORY_TABS.map(loadTab));
  let matches = allTabs.flat().filter((item) => item.productName.toLowerCase() === target);

  if (grammage) {
    matches = matches.filter((item) => String(item.grammage).trim() === String(grammage).trim());
  }
  if (mrp) {
    matches = matches.filter((item) => String(item.mrp).trim() === String(mrp).trim());
  }

  matches.sort((a, b) => a.priority - b.priority);
  return matches;
}

/**
 * Deducts the given quantity for a product across its priority-ordered
 * batches (lowest priority number first), writing the new Quantity back to
 * each affected cell. Pass grammage/mrp to pin down the exact variant when
 * a product name has multiple grammage/MRP rows. Returns the batch/
 * grammage/mrp info needed for the challan line item.
 *
 * Throws if the product isn't found, or total stock across all its batches
 * is insufficient — callers should surface this clearly rather than
 * silently generating a challan with wrong data.
 */
async function deductStock(productName, quantityNeeded, grammage = null, mrp = null) {
  const batches = await findProductBatches(productName, grammage, mrp);
  if (batches.length === 0) {
    const variant = grammage || mrp ? ` (grammage: ${grammage || "any"}, MRP: ${mrp || "any"})` : "";
    throw new Error(`Product "${productName}"${variant} not found in master sheet (check spelling/grammage/MRP match exactly)`);
  }

  const totalAvailable = batches.reduce((sum, b) => sum + b.quantity, 0);
  if (totalAvailable < quantityNeeded) {
    throw new Error(
      `Insufficient stock for "${productName}": need ${quantityNeeded}, have ${totalAvailable} across ${batches.length} batch(es)`
    );
  }

  const sheets = await getSheetsClient();
  let remaining = quantityNeeded;
  const usedBatches = [];

  for (const batch of batches) {
    if (remaining <= 0) break;
    if (batch.quantity <= 0) continue;

    const take = Math.min(batch.quantity, remaining);
    const newQuantity = batch.quantity - take;

    if (batch.quantityColLetter) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.MASTER_SHEET_ID,
        range: `'${batch.tab}'!${batch.quantityColLetter}${batch.rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [[newQuantity]] },
      });
    }

    usedBatches.push({
      batchNumber: batch.batchNumber,
      mfd: batch.mfd,
      exp: batch.exp,
      quantity: take,
    });
    remaining -= take;
  }

  const first = batches[0];
  return {
    productName: first.productName,
    productType: first.productType,
    grammage: first.grammage,
    mrp: first.mrp,
    // Multiple batches used for one line item are joined for the challan
    batchNo: usedBatches.map((b) => b.batchNumber).filter(Boolean).join(", "),
    mfgDate: usedBatches.map((b) => formatSheetDate(b.mfd)).filter(Boolean).join(", "),
  };
}

function formatSheetDate(val) {
  if (!val) return "";
  const d = new Date(val);
  if (isNaN(d.getTime())) return String(val);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

/** Returns all products across all tabs, grouped by tab, for the Custom
 * challan form's category → product dropdowns. Only returns one entry per
 * unique product name per tab (not one per batch), with the lowest-priority
 * batch's MRP shown as the representative price.
 */
async function listProductsForDropdown() {
  const allTabs = await Promise.all(CATEGORY_TABS.map((tab) => loadTab(tab).then((items) => ({ tab, items }))));

  return allTabs.map(({ tab, items }) => {
    const byName = {};
    for (const item of items) {
      if (!byName[item.productName] || item.priority < byName[item.productName].priority) {
        byName[item.productName] = item;
      }
    }
    return {
      category: tab,
      products: Object.values(byName).map((p) => ({
        name: p.productName,
        mrp: p.mrp,
        grammage: p.grammage,
      })),
    };
  });
}

module.exports = { findProductBatches, deductStock, listProductsForDropdown, resolveWebsiteProduct, CATEGORY_TABS };

/**
 * Looks up a website-facing product name (as it appears on a Shopify/Amazon
 * order) in the "Website Product Mapping" tab, returning the underlying
 * base product name + exact grammage/MRP variant (matching a specific row
 * in a category tab) and how many base units one sale represents.
 *
 * Returns null if there's no mapping entry — callers should treat this as
 * "we don't know how to deduct stock for this product" rather than
 * guessing, since a wrong guess here silently corrupts stock counts.
 */
async function resolveWebsiteProduct(websiteProductName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${MAPPING_TAB}'!A1:E500`,
  });

  const rows = res.data.values || [];
  const header = rows[0] || [];
  const nameCol = header.indexOf("Website Product Name");
  const baseCol = header.indexOf("Base Product Name");
  const grammageCol = header.indexOf("Grammage");
  const mrpCol = header.indexOf("MRP");
  const unitsCol = header.indexOf("Units Per Pack");

  const target = websiteProductName.trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if ((row[nameCol] || "").trim().toLowerCase() === target) {
      return {
        baseProductName: row[baseCol],
        grammage: row[grammageCol],
        mrp: row[mrpCol],
        unitsPerPack: parseInt(row[unitsCol], 10) || 1,
      };
    }
  }
  return null;
}

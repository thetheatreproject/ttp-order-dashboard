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
  "Extra", // non-priced items with real quantity tracking: freebies, gift cards, coupons — no MRP/Grammage columns
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

// Same idea as MAPPING_TAB, but for CRED orders. A CRED SKU can be a combo
// (e.g. a gift box of 3 flavors), so unlike the website mapping tab where
// each website product name maps to exactly one row, a single CRED
// product name can appear across MULTIPLE rows here — one row per
// component product in the combo, with "Cred Product Name" written once
// on the first row and left blank below (same forward-fill convention as
// the category tabs). Exact column headers:
//   Cred Product Name | Base Product Name | Grammage | MRP | Units Per Pack
const CRED_MAPPING_TAB = "Cred Product Mapping";

// Same idea as CRED_MAPPING_TAB, but for Amazon orders. An Amazon product
// name can also be a combo (multiple base products under one listing),
// so this follows the same forward-fill/multi-row pattern. Exact column
// headers:
//   Amazon Product Name | Base Product Name | Grammage | MRP | Units Per Pack
const AMAZON_MAPPING_TAB = "Amazon Product Mapping";

// Short-lived cache for category tab reads. Google Sheets caps reads at
// 60/minute per user — with 6 category tabs read on every dropdown load
// AND every challan generation, a few quick actions in a row can blow
// through that limit fast. Caching for a short window means loading the
// form then immediately submitting reuses the same data instead of
// re-reading identical rows twice. TTL is short enough that real stock
// changes (from a challan a moment ago) are still picked up quickly.
const TAB_CACHE_TTL_MS = 20000;
const tabCache = new Map();

function getCachedTab(tabName) {
  const entry = tabCache.get(tabName);
  if (entry && Date.now() - entry.time < TAB_CACHE_TTL_MS) {
    return entry.data;
  }
  return null;
}

function setCachedTab(tabName, data) {
  tabCache.set(tabName, { data, time: Date.now() });
}

// Called after any stock deduction so the next read reflects the new
// quantity immediately, rather than serving a stale cached value for up
// to TAB_CACHE_TTL_MS.
function invalidateTabCache(tabName) {
  tabCache.delete(tabName);
}

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
  const cached = getCachedTab(tabName);
  if (cached) return cached;

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
  let currentProductName = null;
  let currentProductType = null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawProductName = colIndex.productName >= 0 ? row[colIndex.productName] : null;
    const rawProductType = colIndex.productType >= 0 ? row[colIndex.productType] : null;

    // The sheet only fills in Product Name/Type on the first row of each
    // product's group of variant rows (different grammage/MRP), leaving
    // the rows below it blank. Forward-fill from the last seen values so
    // every variant row is correctly attributed to its product.
    if (rawProductName && rawProductName.trim()) {
      currentProductName = rawProductName.trim();
    }
    if (rawProductType && rawProductType.trim()) {
      currentProductType = rawProductType.trim();
    }

    const mrp = colIndex.mrp >= 0 ? row[colIndex.mrp] : null;
    const grammage = colIndex.grammage >= 0 ? row[colIndex.grammage] : null;
    const quantityRaw = colIndex.quantity >= 0 ? row[colIndex.quantity] : null;

    // Skip genuinely empty template rows (no product context yet, or no
    // MRP/grammage/quantity at all — these are just blank spacer rows).
    if (!currentProductName || (!mrp && !grammage && !quantityRaw)) continue;

    items.push({
      tab: tabName,
      rowNumber: i + 1, // 1-indexed to match sheet row numbers
      productType: currentProductType || "",
      productName: currentProductName,
      mrp: mrp || "",
      grammage: grammage || "",
      batchNumber: row[colIndex.batchNumber] || "",
      mfd: row[colIndex.mfd] || "",
      exp: row[colIndex.exp] || "",
      quantity: parseInt(quantityRaw, 10) || 0,
      priority: parseInt(row[colIndex.priority], 10) || 999999,
      quantityColLetter: colIndex.quantity >= 0 ? colLetter(colIndex.quantity) : null,
    });
  }
  setCachedTab(tabName, items);
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
 * Normalizes a grammage/weight value for comparison by stripping any
 * non-numeric characters (so "30g", "30 g", "30", 30 all compare equal).
 */
function normalizeGrammage(val) {
  return String(val).replace(/[^0-9.]/g, "").trim();
}

/**
 * Normalizes an MRP value for comparison (strips currency symbols/commas,
 * compares as a number so "30", "30.00", "Rs 30" all compare equal).
 */
function normalizeMrp(val) {
  const num = parseFloat(String(val).replace(/[^0-9.]/g, ""));
  return isNaN(num) ? null : num;
}

/**
 * Finds every batch row across all category tabs matching a product name
 * exactly (case-insensitive, trimmed), sorted by Priority ascending — the
 * order batches should be used in. If grammage/mrp are provided, also
 * filters to that exact variant — needed since the same product name can
 * appear at multiple grammage/MRP combinations in a category tab. Grammage
 * and MRP comparisons are normalized (units/formatting-tolerant) so "30g"
 * in a mapping tab matches "30" in the category tab.
 */
async function findProductBatches(productName, grammage = null, mrp = null) {
  const target = productName.trim().toLowerCase();
  const allTabs = await Promise.all(CATEGORY_TABS.map(loadTab));
  let matches = allTabs.flat().filter((item) => item.productName.toLowerCase() === target);

  if (grammage) {
    const targetGrammage = normalizeGrammage(grammage);
    matches = matches.filter((item) => normalizeGrammage(item.grammage) === targetGrammage);
  }
  if (mrp) {
    const targetMrp = normalizeMrp(mrp);
    matches = matches.filter((item) => normalizeMrp(item.mrp) === targetMrp);
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
      invalidateTabCache(batch.tab);
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
 * challan form's category → product → variant dropdowns. Unlike the old
 * version, this keeps EVERY grammage/MRP variant per product name rather
 * than collapsing to one — a product can legitimately be sold at several
 * different grammage/MRP combinations (e.g. 30g/Rs30, 60g/Rs60), and all
 * of them need to be selectable, not just whichever the sheet happens to
 * list first.
 */
async function listProductsForDropdown() {
  const allTabs = await Promise.all(CATEGORY_TABS.map((tab) => loadTab(tab).then((items) => ({ tab, items }))));

  return allTabs.map(({ tab, items }) => {
    const byName = {};
    for (const item of items) {
      if (!byName[item.productName]) {
        byName[item.productName] = [];
      }
      // Same product can appear across multiple batch rows at the same
      // grammage/MRP (different batches) — only keep one entry per
      // distinct grammage+MRP combination, not one per batch row.
      const alreadyListed = byName[item.productName].some(
        (v) => v.grammage === item.grammage && v.mrp === item.mrp
      );
      if (!alreadyListed) {
        byName[item.productName].push({ grammage: item.grammage, mrp: item.mrp });
      }
    }
    return {
      category: tab,
      products: Object.entries(byName).map(([name, variants]) => ({ name, variants })),
    };
  });
}

module.exports = {
  findProductBatches,
  deductStock,
  listProductsForDropdown,
  resolveWebsiteProduct,
  resolveCredSku,
  resolveAmazonProduct,
  CATEGORY_TABS,
};

/**
 * Looks up a CRED SKU in the "CRED SKU Mapping" tab, returning every
 * component product it represents — a single-item SKU resolves to one
 * component, a combo SKU resolves to several (all rows sharing that CRED
 * SKU value). All inventory data (stock, batch, actual grammage/MRP) still
 * lives in the category tabs, same as resolveWebsiteProduct — this tab
 * only pins down which base product + variant each CRED SKU corresponds
 * to and how many units of it one sale represents.
 *
 * Returns null if the SKU has no rows in the tab — callers should treat
 * this as "we don't know how to deduct stock for this SKU" rather than
 * guessing, same reasoning as resolveWebsiteProduct.
 */
/**
 * Looks up a CRED product name in the "CRED SKU Mapping" tab, returning
 * every component product it represents — a single-item product resolves
 * to one component, a combo resolves to several (all rows following that
 * product's name, up to the next named row). All inventory data (stock,
 * batch, actual grammage/MRP) still lives in the category tabs, same as
 * resolveWebsiteProduct — this tab only pins down which base product +
 * variant each CRED product corresponds to and how many units of it one
 * sale represents.
 *
 * Returns null if the product has no rows in the tab — callers should
 * treat this as "we don't know how to deduct stock for this product"
 * rather than guessing, same reasoning as resolveWebsiteProduct.
 */
async function resolveCredSku(credSkuOrName) {
  const cached = getCachedTab(CRED_MAPPING_TAB);
  let rows;
  if (cached) {
    rows = cached;
  } else {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      range: `'${CRED_MAPPING_TAB}'!A1:E500`,
    });
    rows = res.data.values || [];
    setCachedTab(CRED_MAPPING_TAB, rows);
  }

  const header = rows[0] || [];
  const nameCol = header.indexOf("Cred Product Name");
  const baseCol = header.indexOf("Base Product Name");
  const grammageCol = header.indexOf("Grammage");
  const mrpCol = header.indexOf("MRP");
  const unitsCol = header.indexOf("Units Per Pack");

  const target = credSkuOrName.trim().toLowerCase();
  const components = [];

  // Cred Product Name is only filled in on the first row of each
  // product's group of component rows (blank below, same convention as
  // the category tabs) — forward-fill it so every component row is
  // correctly attributed.
  let currentProductName = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = nameCol >= 0 ? row[nameCol] : null;
    if (rawName && rawName.trim()) {
      currentProductName = rawName.trim();
    }
    if (!currentProductName) continue;

    if (currentProductName.toLowerCase() === target) {
      const baseProductName = baseCol >= 0 ? row[baseCol] : null;
      if (!baseProductName || !baseProductName.trim()) continue; // skip blank spacer rows
      components.push({
        baseProductName: baseProductName.trim(),
        grammage: grammageCol >= 0 ? row[grammageCol] : null,
        mrp: mrpCol >= 0 ? row[mrpCol] : null,
        unitsPerPack: parseInt(unitsCol >= 0 ? row[unitsCol] : "", 10) || 1,
      });
    }
  }
  return components.length > 0 ? components : null;
}

/**
 * Looks up an Amazon product name in the "Amazon Product Mapping" tab,
 * returning every component product it represents — same combo-capable
 * pattern as resolveCredSku (an Amazon listing can bundle multiple base
 * products, e.g. a 2-tin gift pack), since Amazon product titles are
 * often long, descriptive combo names rather than single SKUs.
 *
 * Returns null if the product has no rows in the tab.
 */
async function resolveAmazonProduct(amazonProductName) {
  const cached = getCachedTab(AMAZON_MAPPING_TAB);
  let rows;
  if (cached) {
    rows = cached;
  } else {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      range: `'${AMAZON_MAPPING_TAB}'!A1:F500`,
    });
    rows = res.data.values || [];
    setCachedTab(AMAZON_MAPPING_TAB, rows);
  }

  const header = rows[0] || [];
  const nameCol = header.indexOf("Amazon Product Name");
  const baseCol = header.indexOf("Base Product Name");
  const grammageCol = header.indexOf("Grammage");
  const mrpCol = header.indexOf("MRP");
  const unitsCol = header.indexOf("Units Per Pack");

  const target = amazonProductName.trim().toLowerCase();
  const components = [];

  // Amazon Product Name is only filled in on the first row of each
  // product's group of component rows (blank below, same forward-fill
  // convention as the category tabs and CRED Product Mapping).
  let currentProductName = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = nameCol >= 0 ? row[nameCol] : null;
    if (rawName && rawName.trim()) {
      currentProductName = rawName.trim();
    }
    if (!currentProductName) continue;

    if (currentProductName.toLowerCase() === target) {
      const baseProductName = baseCol >= 0 ? row[baseCol] : null;
      if (!baseProductName || !baseProductName.trim()) continue; // skip blank spacer rows
      components.push({
        baseProductName: baseProductName.trim(),
        grammage: grammageCol >= 0 ? row[grammageCol] : null,
        mrp: mrpCol >= 0 ? row[mrpCol] : null,
        unitsPerPack: parseInt(unitsCol >= 0 ? row[unitsCol] : "", 10) || 1,
      });
    }
  }
  return components.length > 0 ? components : null;
}

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
/**
 * Looks up a website-facing product name (as it appears on a Shopify
 * order) in the "Website Product Mapping" tab, returning every component
 * product it represents — same combo-capable pattern as
 * resolveAmazonProduct/resolveCredSku. A single-item product resolves to
 * one component; a combo (multiple base products under one website
 * listing) resolves to several, following the same forward-fill
 * convention already used throughout your sheet (name written once on
 * the first row of a combo, blank on the rows below).
 *
 * Returns null if the product has no rows in the tab.
 */
async function resolveWebsiteProduct(websiteProductName) {
  const cached = getCachedTab(MAPPING_TAB);
  let rows;
  if (cached) {
    rows = cached;
  } else {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      range: `'${MAPPING_TAB}'!A1:F500`,
    });
    rows = res.data.values || [];
    setCachedTab(MAPPING_TAB, rows);
  }

  const header = rows[0] || [];
  const nameCol = header.indexOf("Website Product Name");
  const baseCol = header.indexOf("Base Product Name");
  const grammageCol = header.indexOf("Grammage");
  const mrpCol = header.indexOf("MRP");
  const unitsCol = header.indexOf("Units Per Pack");

  const target = normalizeForMatch(websiteProductName);
  const components = [];

  // Website Product Name is only filled in on the first row of each
  // product's group of component rows (blank below) — forward-fill it
  // so every component row is correctly attributed to its combo.
  let currentProductName = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = nameCol >= 0 ? row[nameCol] : null;
    if (rawName && rawName.trim()) {
      currentProductName = rawName.trim();
    }
    if (!currentProductName) continue;

    if (normalizeForMatch(currentProductName) === target) {
      const baseProductName = baseCol >= 0 ? row[baseCol] : null;
      if (!baseProductName || !baseProductName.trim()) continue; // skip blank spacer rows
      components.push({
        baseProductName: baseProductName.trim(),
        grammage: grammageCol >= 0 ? row[grammageCol] : null,
        mrp: mrpCol >= 0 ? row[mrpCol] : null,
        unitsPerPack: parseInt(unitsCol >= 0 ? row[unitsCol] : "", 10) || 1,
      });
    }
  }
  return components.length > 0 ? components : null;
}

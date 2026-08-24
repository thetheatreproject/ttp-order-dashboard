const { google } = require("googleapis");

// Tracks which orders already had a challan generated, along with the exact
// batch data used — so a re-download doesn't deduct stock again. This lives
// in a Google Sheet tab (not a local file) because Render's free tier wipes
// local disk every time the service sleeps and restarts, which was silently
// losing this tracking overnight and making already-downloaded orders show
// as "new" again the next day.
const LOG_TAB = "Challan Log";

let sheetsClientPromise = null;

async function getSheetsClient() {
  if (!sheetsClientPromise) {
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

/**
 * Ensures the "Challan Log" tab exists with the right header row. The
 * existence check itself only needs to happen once per server process —
 * the tab doesn't disappear once created — so this is cached in memory
 * rather than calling spreadsheets.get() (a full read request) on every
 * single challan/order-list lookup, which was needlessly burning through
 * Google's per-minute read quota.
 */
let logTabConfirmedToExist = false;
async function ensureLogTab() {
  if (logTabConfirmedToExist) return;

  const sheets = await getSheetsClient();
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: process.env.MASTER_SHEET_ID });
  const exists = spreadsheet.data.sheets.some((s) => s.properties.title === LOG_TAB);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      range: `'${LOG_TAB}'!A1:C1`,
      valueInputOption: "RAW",
      requestBody: { values: [["Order ID", "Generated At", "Line Items (JSON)"]] },
    });
  }
  logTabConfirmedToExist = true;
}

/**
 * Reads the entire Challan Log once and returns it as a Map keyed by
 * order ID. Use this instead of calling getPreviousChallan() in a loop
 * over an order list — checking N orders that way means N separate
 * reads (one full-tab fetch each), which is exactly what was blowing
 * through Google's read-request quota when a page loaded 15-25 orders
 * at once. One batch read here replaces all of those.
 */
async function getAllChallans() {
  await ensureLogTab();
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${LOG_TAB}'!A2:C`,
  });

  const rows = res.data.values || [];
  const byOrderId = new Map();
  for (const row of rows) {
    if (!row[0]) continue;
    byOrderId.set(row[0], {
      generatedAt: row[1],
      lineItems: JSON.parse(row[2] || "[]"),
    });
  }
  return byOrderId;
}

/**
 * Returns the previously-recorded enriched line items (with batch numbers
 * already assigned) for this order, or null if a challan has never been
 * generated for it before. Use this for single-order lookups (e.g. when
 * actually generating a challan) — for checking many orders at once, use
 * getAllChallans() instead to avoid N separate reads.
 */
async function getPreviousChallan(orderId) {
  const all = await getAllChallans();
  return all.get(orderId) || null;
}

/**
 * Records that a challan was generated for this order, along with the
 * exact enriched line items (batch numbers etc.) that were used — so any
 * future re-download reuses the same data instead of touching stock again.
 */
async function recordChallan(orderId, enrichedLineItems) {
  await ensureLogTab();
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${LOG_TAB}'!A:C`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[orderId, new Date().toISOString(), JSON.stringify(enrichedLineItems)]],
    },
  });
}

module.exports = { getPreviousChallan, getAllChallans, recordChallan };

const { google } = require("googleapis");

/**
 * CRED orders arrive via an Easyecom webhook (Trigger: "Create Order",
 * Marketplace: CRED-API, Action: V2), since CRED itself has no seller API —
 * Easyecom is the order-management layer that already aggregates CRED
 * orders and can push them out as a webhook.
 *
 * NOTE ON PAYLOAD SHAPE: Easyecom's exact V2 "Create Order" payload
 * structure hasn't been confirmed against a real order yet. This module
 * stores the raw payload for every webhook call (so nothing is lost even
 * if the parser below is wrong) and makes a best-effort attempt to
 * normalize it into the same order shape shopify.js/amazon.js produce.
 * Once a real order comes through, check the raw payload (logged to the
 * console, and stored in the "CRED Orders Raw" sheet tab) and we'll
 * correct field names in normalizeCredOrder() to match exactly.
 *
 * Requires env var:
 *   CRED_WEBHOOK_SECRET   The token pasted into Easyecom's "Auth/Token"
 *                          field for this webhook (Auth Type: Authorization
 *                          Token). Verified against the incoming request's
 *                          Authorization header.
 */

const RAW_LOG_TAB = "CRED Orders Raw";

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

async function ensureRawLogTab() {
  const sheets = await getSheetsClient();
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: process.env.MASTER_SHEET_ID });
  const exists = spreadsheet.data.sheets.some((s) => s.properties.title === RAW_LOG_TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: RAW_LOG_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      range: `'${RAW_LOG_TAB}'!A1:C1`,
      valueInputOption: "RAW",
      requestBody: { values: [["Received At", "Order ID (best guess)", "Raw Payload (JSON)"]] },
    });
  }
}

/**
 * Verifies the webhook's Authorization header against our shared secret.
 * Handles both a raw-token header and a "Bearer <token>" header, since
 * Easyecom's exact header format for "Authorization Token" auth hasn't
 * been confirmed yet — safe to narrow this down once we see a real call.
 */
function isAuthorized(req) {
  const expected = process.env.CRED_WEBHOOK_SECRET;
  if (!expected) return false;
  const header = req.get("Authorization") || req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === expected;
}

/**
 * Stores every incoming payload verbatim, regardless of whether we can
 * parse it — this is the safety net while we confirm the real field
 * names. Keyed loosely by whatever looks like an order ID, purely for
 * human scanning of the log; not used for lookups.
 */
async function storeRawPayload(payload) {
  await ensureRawLogTab();
  const sheets = await getSheetsClient();
  const guessedOrderId =
    payload.order_id || payload.orderId || payload.OrderId || payload.reference_code || "unknown";
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${RAW_LOG_TAB}'!A:C`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[new Date().toISOString(), String(guessedOrderId), JSON.stringify(payload)]],
    },
  });
}

/**
 * Best-effort normalization into the shared order shape (id, orderId,
 * createdAt, customerName, shippingAddress, lineItems, totalPrice, etc).
 * UNVERIFIED against a real payload — field names here are informed
 * guesses based on common Easyecom/order-webhook conventions. Expect to
 * revise this once we see one real "Create Order" call in the raw log.
 */
function normalizeCredOrder(payload) {
  const orderId = String(
    payload.order_id || payload.orderId || payload.reference_code || payload.invoice_number || "UNKNOWN"
  );

  const rawItems = payload.order_items || payload.items || payload.line_items || [];
  const lineItems = rawItems.map((li) => ({
    sku: li.sku || li.sku_code || li.item_sku,
    title: li.product_name || li.name || li.item_name,
    quantity: parseInt(li.quantity || li.qty, 10) || 0,
    price: li.price || li.selling_price || li.unit_price || "0",
    unitDiscount: parseFloat(li.discount) || 0,
  }));

  const shippingAddress = payload.shipping_address || payload.customer_address || {};

  return {
    id: orderId,
    orderId: orderId,
    createdAt: payload.order_date || payload.created_at || new Date().toISOString(),
    customerName: payload.customer_name || shippingAddress.name || "N/A",
    customerOrdersCount: 0,
    customerPhone: payload.customer_phone || shippingAddress.phone || "",
    shippingAddress: {
      address1: shippingAddress.address1 || shippingAddress.address_line1 || "",
      address2: shippingAddress.address2 || shippingAddress.address_line2 || "",
      city: shippingAddress.city || "",
      province: shippingAddress.state || shippingAddress.province || "",
      zip: shippingAddress.pincode || shippingAddress.zip || "",
      country: shippingAddress.country || "India",
    },
    financialStatus: "paid",
    lineItems,
    totalPrice: (parseFloat(payload.order_total || payload.total_amount) || 0).toFixed(2),
    _raw: payload, // kept temporarily for debugging while we confirm field names
  };
}

/**
 * Handles one incoming webhook call: verifies auth, stores the raw
 * payload, and returns the best-effort normalized order (or throws if
 * unauthorized). Called from the /webhooks/cred-orders route in
 * server.js.
 */
async function handleWebhook(req) {
  if (!isAuthorized(req)) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  await storeRawPayload(req.body);
  return normalizeCredOrder(req.body);
}

/**
 * Lists recently received CRED orders by reading back through the raw
 * log and normalizing each row — since there's no separate "list orders"
 * API to call (Easyecom only pushes to us), this log IS the order list.
 */
async function listRecentOrders(limit = 25) {
  await ensureRawLogTab();
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${RAW_LOG_TAB}'!A2:C`,
  });
  const rows = res.data.values || [];
  const orders = rows
    .map((row) => {
      try {
        return normalizeCredOrder(JSON.parse(row[2]));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Most recently received first
  orders.reverse();
  return orders.slice(0, limit);
}

async function getOrderById(orderId) {
  const orders = await listRecentOrders(500);
  return orders.find((o) => o.orderId === orderId) || null;
}

module.exports = { handleWebhook, listRecentOrders, getOrderById };

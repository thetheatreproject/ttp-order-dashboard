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
 * CONFIRMED 2026-09-04 against a real order: Easyecom's "Create Order"
 * webhook sends the payload as a JSON ARRAY of order objects — even when
 * there's only one order in the call — not a bare object as originally
 * guessed. This normalizes either shape into an array so the rest of the
 * module can treat it uniformly.
 */
function unwrapOrders(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

/**
 * Stores every incoming payload verbatim (the raw array, as received) —
 * this is the safety net so nothing is lost even if normalization below
 * needs revising later. Keyed loosely by whatever looks like an order ID,
 * purely for human scanning of the log; not used for lookups.
 */
async function storeRawPayload(payload) {
  await ensureRawLogTab();
  const sheets = await getSheetsClient();
  const guessedOrderId =
    unwrapOrders(payload)
      .map((o) => o.order_id || o.reference_code || o.invoice_number || "unknown")
      .join(", ") || "unknown";
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
 * Normalizes ONE order object (already unwrapped from the array) into the
 * shared order shape (id, orderId, createdAt, customerName, shippingAddress,
 * lineItems, totalPrice, etc) — the same shape shopify.js/amazon.js produce,
 * which generateChallan.js/generateInvoice.js already consume. Field names
 * below are CONFIRMED against a real Easyecom CRED-API payload received
 * 2026-09-04 (order_id 611645678 / reference_code 4GXE42JRXLVQ3).
 */
function normalizeCredOrder(order) {
  const orderId = String(order.order_id || order.reference_code || order.invoice_number || "UNKNOWN");

  const rawItems = order.order_items || [];
  const lineItems = rawItems.map((li) => {
    const mrp = parseFloat(li.mrp) || 0;
    const sellingPrice = parseFloat(li.selling_price) || 0;
    return {
      sku: li.sku || "",
      title: li.productName || li.sku || "",
      quantity: parseInt(li.item_quantity, 10) || 0,
      price: li.selling_price || "0",
      // Easyecom doesn't send a discount field directly — derive it from
      // MRP vs selling price (never negative).
      unitDiscount: Math.max(0, mrp - sellingPrice),
    };
  });

  return {
    id: orderId,
    orderId: orderId,
    createdAt: order.order_date || new Date().toISOString(),
    customerName: order.customer_name || order.shipping_name || order.billing_name || "N/A",
    customerOrdersCount: 0,
    customerPhone: order.contact_num || order.billing_mobile || "",
    shippingAddress: {
      address1: order.address_line_1 || "",
      address2: order.address_line_2 || "",
      city: order.city || "",
      province: order.state || "",
      zip: order.pin_code || "",
      country: order.country || "India",
    },
    financialStatus: "paid",
    lineItems,
    totalPrice: (parseFloat(order.total_amount) || 0).toFixed(2),
    _raw: order,
  };
}

/**
 * Handles one incoming webhook call: verifies auth, stores the raw
 * payload, and returns the best-effort normalized order(s) (or throws if
 * unauthorized). Returns an ARRAY since Easyecom's payload is an array
 * and could in principle contain more than one order in a single call.
 * Called from the /webhooks/cred-orders route in server.js.
 */
async function handleWebhook(req) {
  if (!isAuthorized(req)) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  await storeRawPayload(req.body);
  const orders = unwrapOrders(req.body).map(normalizeCredOrder);
  if (orders.length === 0) {
    const err = new Error("Empty CRED webhook payload");
    err.statusCode = 400;
    throw err;
  }
  return orders;
}

/**
 * Lists recently received CRED orders by reading back through the raw
 * log and normalizing each row — since there's no separate "list orders"
 * API to call (Easyecom only pushes to us), this log IS the order list.
 * Each row's payload is itself an array (Easyecom's shape), so this
 * flattens across rows and across orders within a row.
 */
async function listRecentOrders(limit = 25) {
  await ensureRawLogTab();
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `'${RAW_LOG_TAB}'!A2:C`,
  });
  const rows = res.data.values || [];
  const orders = rows.flatMap((row) => {
    try {
      return unwrapOrders(JSON.parse(row[2])).map(normalizeCredOrder);
    } catch {
      return [];
    }
  });

  // Most recently received first
  orders.reverse();
  return orders.slice(0, limit);
}

async function getOrderById(orderId) {
  const orders = await listRecentOrders(500);
  return orders.find((o) => o.orderId === orderId) || null;
}

module.exports = { handleWebhook, listRecentOrders, getOrderById };

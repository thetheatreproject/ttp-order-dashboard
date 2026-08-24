const SellingPartner = require("amazon-sp-api");

/**
 * Amazon orders, pulled directly from Amazon's own Selling Partner API
 * (SP-API) — no third-party service, no trial period, free forever (Amazon
 * doesn't charge for API access on a self-authorized private app).
 *
 * TTP never self-ships on Amazon, so every order here is FBA — Amazon
 * already holds the stock, but a challan/invoice is still generated per
 * order the same way as Shopify, per Aniket's instruction.
 *
 * SETUP REQUIRED (one-time, in Seller Central):
 *   1. Apps & Services -> Develop Apps -> Add new app client
 *      -> "I will authorize this app myself" (self-authorization)
 *   2. Grant it the "Orders" role
 *   3. IMPORTANT: request PII approval for the app (Amazon has to approve
 *      this separately — without it, buyer name/address/phone will come
 *      back blank even though the API calls succeed). This is requested
 *      as part of the app's role/permission setup in Seller Central; look
 *      for "restricted data" / PII access when configuring the app.
 *   4. Seller Central will show a Client ID, Client Secret, and a
 *      Refresh Token (shown once — save it immediately).
 *
 * Requires env vars:
 *   AMAZON_SP_CLIENT_ID
 *   AMAZON_SP_CLIENT_SECRET
 *   AMAZON_SP_REFRESH_TOKEN
 *   AMAZON_MARKETPLACE_ID     India = A21TJRUUN4KGV (default if unset)
 */

const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || "A21TJRUUN4KGV"; // Amazon.in
const REGION = "eu"; // SP-API groups the India marketplace under the "eu" region endpoint

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const { AMAZON_SP_CLIENT_ID, AMAZON_SP_CLIENT_SECRET, AMAZON_SP_REFRESH_TOKEN } = process.env;
    if (!AMAZON_SP_CLIENT_ID || !AMAZON_SP_CLIENT_SECRET || !AMAZON_SP_REFRESH_TOKEN) {
      throw new Error(
        "AMAZON_SP_CLIENT_ID / AMAZON_SP_CLIENT_SECRET / AMAZON_SP_REFRESH_TOKEN not set in .env"
      );
    }
    clientPromise = Promise.resolve(
      new SellingPartner({
        region: REGION,
        refresh_token: AMAZON_SP_REFRESH_TOKEN,
        credentials: {
          SELLING_PARTNER_APP_CLIENT_ID: AMAZON_SP_CLIENT_ID,
          SELLING_PARTNER_APP_CLIENT_SECRET: AMAZON_SP_CLIENT_SECRET,
        },
      })
    );
  }
  return clientPromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Address/buyer-name fields are PII-restricted by Amazon. TTP's app was
 * only approved for the non-restricted "Inventory and Order Tracking"
 * role — not the Restricted roles needed for buyer PII — so these
 * fields are deliberately left blank rather than fetched. (Confirmed
 * with Aniket: blank name/address on Amazon challans/invoices is fine —
 * only order ID/invoice number matters there.) If PII access is approved
 * in the future, reintroduce a getOrderAddress call using a Restricted
 * Data Token here.
 */

async function getOrderItems(client, orderId) {
  const res = await client.callAPI({
    operation: "getOrderItems",
    endpoint: "orders",
    path: { orderId },
  });
  // The amazon-sp-api client already unwraps the API's outer envelope, so
  // `res` here IS the payload directly, not something wrapped inside a
  // .payload property — confirmed by listRecentOrders() already working
  // via listRes.Orders (not listRes.payload.Orders). Fall back to
  // res.payload defensively in case that ever changes.
  const payload = res.OrderItems ? res : res.payload || {};
  return payload.OrderItems || [];
}

/**
 * Normalizes one Amazon order (base order + items) into the same shape
 * shopify.js's normalizeOrder produces, so server.js/generateChallan.js/
 * generateInvoice.js don't need channel-specific branches. `items` can be
 * omitted (empty array) for the order-list view, which never displays
 * line items and shouldn't pay the cost of fetching them — only
 * getOrderById (used when actually generating a challan for one order)
 * passes real items.
 */
function buildOrder(baseOrder, items = []) {
  const lineItems = items.map((li) => {
    const quantity = li.QuantityOrdered || 0;
    const itemPrice = parseFloat(li.ItemPrice && li.ItemPrice.Amount) || 0; // aggregate, not per-unit
    const promoDiscount = parseFloat(li.PromotionDiscount && li.PromotionDiscount.Amount) || 0;
    return {
      sku: li.SellerSKU,
      title: li.Title,
      quantity,
      price: quantity > 0 ? (itemPrice / quantity).toFixed(2) : "0",
      unitDiscount: quantity > 0 ? promoDiscount / quantity : 0,
    };
  });

  const totalPrice = parseFloat(baseOrder.OrderTotal && baseOrder.OrderTotal.Amount) || 0;

  return {
    id: baseOrder.AmazonOrderId,
    orderId: baseOrder.AmazonOrderId,
    createdAt: baseOrder.PurchaseDate,
    customerName: "N/A", // PII-restricted — see note above
    customerOrdersCount: 0, // SP-API doesn't expose repeat-customer counts the way Shopify does
    customerPhone: "", // PII-restricted — see note above
    shippingAddress: {
      address1: "", // PII-restricted — see note above
      address2: "",
      city: "",
      province: "",
      zip: "",
      country: "IN",
    },
    financialStatus: "paid", // Amazon settles centrally; FBA orders are prepaid from TTP's side
    lineItems,
    totalPrice: totalPrice.toFixed(2),
  };
}

/**
 * Lists recent Amazon FBA orders (most recent first), for the order-list
 * screen only. Deliberately does NOT fetch each order's line items —
 * that data isn't shown in the list view, and fetching it per order
 * (rate-limited to about one every 2 seconds) was the entire reason this
 * used to take minutes to load for 15+ orders. Line items are fetched
 * fresh, on demand, only when a specific order's challan is actually
 * generated (see getOrderById below) — this makes the list itself fast,
 * bounded mainly by however many getOrders pages Amazon returns.
 *
 * Amazon's getOrders caps each response at roughly 100 orders — with TTP
 * getting 6-8 orders a day, a 30-day lookback window can be 200+ orders,
 * spanning multiple pages. This follows NextToken to walk through every
 * page rather than silently only seeing whichever page Amazon happened
 * to return first (which is NOT guaranteed to be the most recent one).
 */
async function listRecentOrders(limit = 15, lookbackDays = 7) {
  const client = await getClient();
  const createdAfter = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  let allBaseOrders = [];
  let nextToken = null;
  let pageCount = 0;
  const MAX_PAGES = 10; // safety cap — 10 pages at ~100/page covers 1000+ orders

  do {
    const query = nextToken
      ? { NextToken: nextToken } // per Amazon's pagination convention, other filters are dropped on continuation calls
      : { MarketplaceIds: [MARKETPLACE_ID], CreatedAfter: createdAfter };

    const listRes = await client.callAPI({ operation: "getOrders", endpoint: "orders", query });
    allBaseOrders = allBaseOrders.concat(listRes.Orders || []);
    nextToken = listRes.NextToken || null;
    pageCount++;
    if (nextToken) await sleep(2100); // getOrders is also rate-limited between page fetches
  } while (nextToken && pageCount < MAX_PAGES);

  // Amazon's getOrders doesn't guarantee newest-first ordering — sort
  // explicitly before taking the first `limit`, otherwise the most
  // recent order can end up past the cutoff and never show up.
  const sortedOrders = allBaseOrders.sort(
    (a, b) => new Date(b.PurchaseDate) - new Date(a.PurchaseDate)
  );
  const baseOrders = sortedOrders.slice(0, limit);

  // No per-order getOrderItems calls here — see doc comment above.
  return baseOrders.map((baseOrder) => buildOrder(baseOrder));
}

/**
 * Fetches a single order by its Amazon order ID (used when generating a
 * challan/invoice for one specific order from the order list).
 */
async function getOrderById(orderId) {
  const client = await getClient();
  const res = await client.callAPI({
    operation: "getOrder",
    endpoint: "orders",
    path: { orderId },
  });
  // Same unwrapping note as getOrderItems above — res is the order object
  // directly (has AmazonOrderId etc.), not nested under .payload.
  const baseOrder = res.AmazonOrderId ? res : res.payload;
  if (!baseOrder) return null;

  const items = await getOrderItems(client, orderId);

  return buildOrder(baseOrder, items);
}

module.exports = { listRecentOrders, getOrderById };

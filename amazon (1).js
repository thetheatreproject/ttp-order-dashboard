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
 * Address/buyer-name fields are PII-restricted by Amazon — a plain
 * getOrderAddress call comes back with those fields blank unless the
 * request carries a Restricted Data Token (RDT) scoped to that specific
 * order, AND the app has been approved by Amazon for PII access (see
 * setup notes above). This requests that token for a single order.
 */
async function getRestrictedDataToken(client, orderId) {
  const res = await client.callAPI({
    operation: "createRestrictedDataToken",
    endpoint: "tokens",
    body: {
      restrictedResources: [
        {
          method: "GET",
          path: `/orders/v0/orders/${orderId}/address`,
          dataElements: ["buyerInfo", "shippingAddress"],
        },
      ],
    },
  });
  return res.restrictedDataToken;
}

async function getOrderAddress(client, orderId) {
  const rdt = await getRestrictedDataToken(client, orderId);
  const res = await client.callAPI({
    operation: "getOrderAddress",
    endpoint: "orders",
    path: { orderId },
    restricted_data_token: rdt,
  });
  return res.payload || {};
}

async function getOrderItems(client, orderId) {
  const res = await client.callAPI({
    operation: "getOrderItems",
    endpoint: "orders",
    path: { orderId },
  });
  return (res.payload && res.payload.OrderItems) || [];
}

/**
 * Normalizes one Amazon order (base order + address + items) into the
 * same shape shopify.js's normalizeOrder produces, so server.js/
 * generateChallan.js/generateInvoice.js don't need channel-specific
 * branches.
 */
function buildOrder(baseOrder, address, items) {
  const shipping = address.ShippingAddress || {};
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
    customerName: shipping.Name || (address.BuyerInfo && address.BuyerInfo.Name) || "N/A",
    customerOrdersCount: 0, // SP-API doesn't expose repeat-customer counts the way Shopify does
    customerPhone: shipping.Phone || "",
    shippingAddress: {
      address1: shipping.AddressLine1 || "",
      address2: [shipping.AddressLine2, shipping.AddressLine3].filter(Boolean).join(", "),
      city: shipping.City || "",
      province: shipping.StateOrRegion || "",
      zip: shipping.PostalCode || "",
      country: shipping.CountryCode || "IN",
    },
    financialStatus: "paid", // Amazon settles centrally; FBA orders are prepaid from TTP's side
    lineItems,
    totalPrice: totalPrice.toFixed(2),
  };
}

/**
 * Lists recent Amazon FBA orders (most recent first). Fetches the base
 * order list in one call, then per order fetches items + a PII-scoped
 * address — those per-order calls are rate-limited by Amazon to about one
 * every 2 seconds, so this deliberately keeps `limit` modest by default;
 * raising it will make "load orders" noticeably slower.
 */
async function listRecentOrders(limit = 15, lookbackDays = 30) {
  const client = await getClient();
  const createdAfter = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const listRes = await client.callAPI({
    operation: "getOrders",
    endpoint: "orders",
    query: {
      MarketplaceIds: [MARKETPLACE_ID],
      CreatedAfter: createdAfter,
    },
  });
  const baseOrders = (listRes.Orders || []).slice(0, limit);

  const orders = [];
  for (const baseOrder of baseOrders) {
    const orderId = baseOrder.AmazonOrderId;
    const items = await getOrderItems(client, orderId);
    await sleep(2100);
    const address = await getOrderAddress(client, orderId);
    await sleep(2100);
    orders.push(buildOrder(baseOrder, address, items));
  }
  return orders;
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
  const baseOrder = res.payload;
  if (!baseOrder) return null;

  const items = await getOrderItems(client, orderId);
  await sleep(2100);
  const address = await getOrderAddress(client, orderId);

  return buildOrder(baseOrder, address, items);
}

module.exports = { listRecentOrders, getOrderById };

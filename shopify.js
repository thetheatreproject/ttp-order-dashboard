const fetch = global.fetch; // Node 18+/22 has fetch built in

/**
 * Fetches an order from Shopify Admin API by order name/number (e.g. "#1234" or "1234")
 * or by numeric order ID if you already have it.
 *
 * Requires env vars:
 *   SHOPIFY_STORE_DOMAIN   e.g. thetheatreproject.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    Admin API access token (Apps > Develop apps > your app)
 */
async function getOrderByName(orderId) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error("SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN not set in .env");
  }

  // Normalize: allow "1234", "#1234", or full order name
  const name = orderId.toString().startsWith("#") ? orderId : `#${orderId}`;

  const url = `https://${domain}/admin/api/2024-10/orders.json?name=${encodeURIComponent(name)}&status=any`;

  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (!data.orders || data.orders.length === 0) {
    return null;
  }

  return normalizeOrder(data.orders[0]);
}

/**
 * Fetches an order by its numeric Shopify order ID (used for webhook-driven
 * lookups, since webhooks give you the numeric id, not the "#1234" name).
 */
async function getOrderById(numericId) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error("SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN not set in .env");
  }

  const url = `https://${domain}/admin/api/2024-10/orders/${numericId}.json`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return normalizeOrder(data.order);
}

/**
 * Lists recent orders (most recent first) for the dashboard's order list view.
 */
async function listRecentOrders(limit = 25) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error("SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN not set in .env");
  }

  const url = `https://${domain}/admin/api/2024-10/orders.json?status=any&limit=${limit}&order=created_at+desc`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.orders || []).map(normalizeOrder);
}

function normalizeOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    orderId: order.name,
    createdAt: order.created_at,
    customerName: order.customer
      ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim()
      : (order.shipping_address ? order.shipping_address.name : "N/A"),
    customerOrdersCount: order.customer ? order.customer.orders_count : 0,
    customerPhone: order.shipping_address?.phone || order.customer?.phone || order.phone || "",
    shippingAddress: order.shipping_address,
    financialStatus: order.financial_status || "",
    cancelledAt: order.cancelled_at || null,
    cancelReason: order.cancel_reason || null,
    lineItems: order.line_items.map((li) => ({
      sku: li.sku,
      title: li.title,
      quantity: li.quantity,
      price: li.price,
      // Shopify gives total discount for the whole line; convert to a
      // per-unit figure since the invoice format shows discount per unit.
      unitDiscount: li.quantity > 0 ? (parseFloat(li.total_discount) || 0) / li.quantity : 0,
    })),
    totalPrice: order.total_price,
  };
}

module.exports = { getOrderByName, getOrderById, listRecentOrders };

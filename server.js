require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { getOrderById, listRecentOrders } = require("./shopify");
const { getOrderById: getAmazonOrderById, listRecentOrders: listRecentAmazonOrders } = require("./amazon");
const { handleWebhook: handleCredWebhook, getOrderById: getCredOrderById, listRecentOrders: listRecentCredOrders } = require("./cred");
const { deductStock, listProductsForDropdown, resolveWebsiteProduct, resolveCredSku, resolveAmazonProduct, formatSheetDate } = require("./masterSheet");
const { generateChallanPdf } = require("./generateChallan");
const { generateInvoicePdf } = require("./generateInvoice");
const { getPreviousChallan, getAllChallans, recordChallan } = require("./challanLog");

const app = express();
const OUTPUT_DIR = path.join(__dirname, "generated_pdfs");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Shopify webhook needs the raw body for HMAC verification — must be
// registered before express.json() runs on it.
app.post("/webhooks/orders-create", express.raw({ type: "application/json" }), (req, res) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");

  if (digest !== hmacHeader) {
    console.warn("Webhook HMAC verification failed");
    return res.status(401).send("Invalid signature");
  }

  const order = JSON.parse(req.body.toString("utf8"));
  console.log(`New order webhook received: ${order.name}`);
  broadcastSSE({ type: "new_order", orderId: order.name });
  res.status(200).send("OK");
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(OUTPUT_DIR));

// ---- Server-Sent Events for the live "new order" dot/count ----
let sseClients = [];
function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => client.write(payload));
}
app.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  sseClients.push(res);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// ---- Background polling for new Amazon orders (Amazon has no webhook
// like Shopify's, so this is how the badge/live-update still works —
// periodically re-check the order list and broadcast an SSE event for
// anything new since the last check) ----
let knownAmazonOrderIds = null; // null = not yet baselined
const AMAZON_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — well within Amazon's rate limits

async function pollAmazonOrders() {
  try {
    const orders = await listRecentAmazonOrders(25);
    const currentIds = new Set(orders.map((o) => o.orderId));

    if (knownAmazonOrderIds === null) {
      // First run since server start — just establish the baseline,
      // don't broadcast for orders that already existed before we
      // started watching (they aren't "new").
      knownAmazonOrderIds = currentIds;
      return;
    }

    for (const id of currentIds) {
      if (!knownAmazonOrderIds.has(id)) {
        console.log(`New Amazon order detected: ${id}`);
        broadcastSSE({ type: "new_amazon_order", orderId: id });
      }
    }
    knownAmazonOrderIds = currentIds;
  } catch (err) {
    console.error("Amazon order poll failed:", err.message);
  }
}
pollAmazonOrders(); // establish baseline immediately on startup
setInterval(pollAmazonOrders, AMAZON_POLL_INTERVAL_MS);

// ---- Shopify order list, with download status per order ----
/**
 * Builds the challan rows for one originally-ordered line item, in the
 * two-tier format used across every channel:
 *   1. A HEADER row showing exactly what the customer ordered (the real
 *      product title, e.g. "Movie Night Blockbuster Box") and the order
 *      quantity — this was previously missing entirely, replaced by just
 *      the resolved base product name, which made it impossible to tell
 *      what was actually sold.
 *   2. One DETAIL row per base-product component, per BATCH actually
 *      drawn from stock. If a component's needed quantity couldn't be
 *      fully covered by its highest-priority batch, deductStock already
 *      splits across the next-priority batch — this surfaces each split
 *      as its own row (batch number, MFG date, and that batch's specific
 *      quantity) instead of merging them into one line, so a priority-1
 *      /priority-2 split is visible on the printed challan.
 *
 * `components` is the array resolveWebsiteProduct/resolveAmazonProduct/
 * resolveCredSku returns (one entry per base product a combo maps to;
 * length 1 for a simple, non-combo product).
 */
async function buildChallanRows(orderedTitle, orderedQuantity, components) {
  const rows = [{ kind: "header", title: orderedTitle, quantity: orderedQuantity }];

  for (const component of components) {
    const baseQuantityNeeded = orderedQuantity * component.unitsPerPack;
    const mrpValue = parseFloat(String(component.mrp).replace(/[^0-9.]/g, "")) || 0;

    if (mrpValue === 0) {
      // Freebie/non-priced item (gift card, coupon, promo item) — lives
      // in the "Extra" category tab, which has no grammage/MRP columns,
      // so deduct by name only. Still one row per batch in case even a
      // freebie's stock spans multiple batches.
      const batchInfo = await deductStock(component.baseProductName, baseQuantityNeeded);
      for (const batch of batchInfo.batches) {
        rows.push({
          kind: "detail",
          title: batchInfo.productName,
          grammage: batchInfo.grammage,
          mrp: "0",
          batchNo: batch.batchNumber,
          mfgDate: formatSheetDate(batch.mfd),
          quantity: batch.quantity,
        });
      }
      continue;
    }

    const batchInfo = await deductStock(
      component.baseProductName,
      baseQuantityNeeded,
      component.grammage,
      component.mrp
    );

    for (const batch of batchInfo.batches) {
      rows.push({
        kind: "detail",
        title: batchInfo.productName,
        grammage: batchInfo.grammage,
        mrp: batchInfo.mrp,
        batchNo: batch.batchNumber,
        mfgDate: formatSheetDate(batch.mfd),
        quantity: batch.quantity,
      });
    }
  }

  return rows;
}

app.get("/api/shopify/orders", async (req, res) => {
  try {
    const orders = await listRecentOrders(25);
    const challanLog = await getAllChallans(); // one read for all orders, not one per order
    const withStatus = orders.map((o) => ({
      ...o,
      downloaded: challanLog.has(`shopify:${o.orderId}`),
    }));
    res.json(withStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Generate a Shopify order's challan (deducts stock only on first generation) ----
app.post("/api/shopify/orders/:id/challan", async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const logKey = `shopify:${order.orderId}`;
    const previous = await getPreviousChallan(logKey);
    let enrichedLineItems;

    if (previous) {
      console.log(`Re-download for ${order.orderId} — skipping stock deduction`);
      enrichedLineItems = previous.lineItems;
    } else {
      enrichedLineItems = [];
      for (const li of order.lineItems) {
        // Website products can be combos (multiple base products under
        // one listing) — resolveWebsiteProduct returns one or more
        // components per product, same pattern as the Amazon/CRED
        // mapping tabs.
        const components = await resolveWebsiteProduct(li.title);
        if (!components) {
          return res.status(422).json({
            error: `"${li.title}" has no entry in the Website Product Mapping tab — add it before generating this challan (Website Product Name, Base Product Name, Units Per Pack).`,
          });
        }
        const rows = await buildChallanRows(li.title, li.quantity, components);
        enrichedLineItems.push(...rows);
      }
      await recordChallan(logKey, enrichedLineItems);
    }

    const challanOrder = {
      ...order,
      orderType: order.customerOrdersCount > 1 ? "Repeat Order" : "New Order",
      totalOrdersCount: order.lineItems.reduce((sum, li) => sum + li.quantity, 0),
    };

    const pdfPath = await generateChallanPdf(challanOrder, enrichedLineItems, OUTPUT_DIR);
    res.json({ url: `/files/${path.basename(pdfPath)}`, stockDeducted: !previous });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Generate a Shopify order's invoice (no stock deduction — invoicing is a billing document, not a stock movement) ----
app.post("/api/shopify/orders/:id/invoice", async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const pdfPath = await generateInvoicePdf(order, order.lineItems, OUTPUT_DIR);
    res.json({ url: `/files/${path.basename(pdfPath)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- CRED order webhook (from Easyecom, which aggregates CRED-API orders) ----
app.post("/webhooks/cred-orders", async (req, res) => {
  try {
    const order = await handleCredWebhook(req);
    console.log(`New CRED order webhook received: ${order.orderId}`);
    console.log("Raw CRED webhook payload:", JSON.stringify(req.body));
    broadcastSSE({ type: "new_cred_order", orderId: order.orderId });
    res.status(200).send("OK");
  } catch (err) {
    if (err.statusCode === 401) {
      console.warn("CRED webhook: unauthorized request");
      return res.status(401).send("Unauthorized");
    }
    console.error(err);
    res.status(500).send("Error processing webhook");
  }
});

// ---- Amazon (FBA) order list, with download status per order ----
app.get("/api/amazon/orders", async (req, res) => {
  try {
    const orders = await listRecentAmazonOrders(25);
    const challanLog = await getAllChallans(); // one read for all orders, not one per order
    const withStatus = orders.map((o) => ({
      ...o,
      downloaded: challanLog.has(`amazon:${o.orderId}`),
    }));
    res.json(withStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Generate an Amazon order's challan (deducts stock only on first generation) ----
app.post("/api/amazon/orders/:id/challan", async (req, res) => {
  try {
    const order = await getAmazonOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const logKey = `amazon:${order.orderId}`;
    const previous = await getPreviousChallan(logKey);
    let enrichedLineItems;

    if (previous) {
      console.log(`Re-download for ${order.orderId} — skipping stock deduction`);
      enrichedLineItems = previous.lineItems;
    } else {
      enrichedLineItems = [];
      for (const li of order.lineItems) {
        // Amazon product names can be combos (multiple base products
        // under one listing), same as CRED — resolveAmazonProduct
        // returns one or more components per product, unlike
        // resolveWebsiteProduct which is always a single product.
        const components = await resolveAmazonProduct(li.title);
        if (!components) {
          return res.status(422).json({
            error: `"${li.title}" has no entry in the Amazon Product Mapping tab — add it before generating this challan (Amazon Product Name, Base Product Name, Units Per Pack).`,
          });
        }
        const rows = await buildChallanRows(li.title, li.quantity, components);
        enrichedLineItems.push(...rows);
      }
      await recordChallan(logKey, enrichedLineItems);
    }

    const challanOrder = {
      ...order,
      orderType: "New Order", // Amazon SP-API doesn't expose repeat-customer counts, unlike Shopify
      totalOrdersCount: order.lineItems.reduce((sum, li) => sum + li.quantity, 0),
    };

    const pdfPath = await generateChallanPdf(challanOrder, enrichedLineItems, OUTPUT_DIR);
    res.json({ url: `/files/${path.basename(pdfPath)}`, stockDeducted: !previous });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Generate an Amazon order's invoice (no stock deduction) ----
app.post("/api/amazon/orders/:id/invoice", async (req, res) => {
  try {
    const order = await getAmazonOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const pdfPath = await generateInvoicePdf(order, order.lineItems, OUTPUT_DIR);
    res.json({ url: `/files/${path.basename(pdfPath)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- CRED order list, with download status per order ----
app.get("/api/cred/orders", async (req, res) => {
  try {
    const orders = await listRecentCredOrders(25);
    const challanLog = await getAllChallans(); // one read for all orders, not one per order
    const withStatus = orders.map((o) => ({
      ...o,
      downloaded: challanLog.has(`cred:${o.orderId}`),
    }));
    res.json(withStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Generate a CRED order's challan (deducts stock only on first generation) ----
app.post("/api/cred/orders/:id/challan", async (req, res) => {
  try {
    const order = await getCredOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const logKey = `cred:${order.orderId}`;
    const previous = await getPreviousChallan(logKey);
    let enrichedLineItems;

    if (previous) {
      console.log(`Re-download for ${order.orderId} — skipping stock deduction`);
      enrichedLineItems = previous.lineItems;
    } else {
      enrichedLineItems = [];
      for (const li of order.lineItems) {
        // CRED SKUs can be combos of multiple base products — resolveCredSku
        // returns one or more base-product components per SKU, unlike
        // resolveWebsiteProduct which is always a single product.
        const components = await resolveCredSku(li.sku || li.title);
        if (!components) {
          return res.status(422).json({
            error: `CRED SKU "${li.sku || li.title}" has no entry in the CRED SKU Details tab — add it before generating this challan.`,
          });
        }
        const rows = await buildChallanRows(li.title || li.sku, li.quantity, components);
        enrichedLineItems.push(...rows);
      }
      await recordChallan(logKey, enrichedLineItems);
    }

    const challanOrder = {
      ...order,
      orderType: "New Order",
      totalOrdersCount: order.lineItems.reduce((sum, li) => sum + li.quantity, 0),
    };

    const pdfPath = await generateChallanPdf(challanOrder, enrichedLineItems, OUTPUT_DIR);
    res.json({ url: `/files/${path.basename(pdfPath)}`, stockDeducted: !previous });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Generate a CRED order's invoice (no stock deduction) ----
app.post("/api/cred/orders/:id/invoice", async (req, res) => {
  try {
    const order = await getCredOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const pdfPath = await generateInvoicePdf(order, order.lineItems, OUTPUT_DIR);
    res.json({ url: `/files/${path.basename(pdfPath)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Product dropdown data for the Custom challan form ----
app.get("/api/products", async (req, res) => {
  try {
    const categories = await listProductsForDropdown();
    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Custom challan generation ----
app.post("/api/custom/challan", async (req, res) => {
  try {
    const { name, phone, address, state, type, items } = req.body;
    if (!name || !address || !type || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const isSample = type.toLowerCase() === "sample";
    const enrichedLineItems = [];
    for (const item of items) {
      // Pass the selected variant's grammage/MRP so the correct row is
      // matched when a product has multiple grammage/MRP combinations —
      // without this, deductStock could pick any variant's batch.
      const batchInfo = await deductStock(item.productName, item.quantity, item.grammage, item.mrp);
      // One row per batch actually drawn from — same reasoning as the
      // other channels: if stock had to split across a priority-1 and
      // priority-2 batch, that split should be visible on the challan.
      for (const batch of batchInfo.batches) {
        enrichedLineItems.push({
          kind: "detail",
          title: batchInfo.productName,
          grammage: batchInfo.grammage,
          batchNo: batch.batchNumber,
          mfgDate: formatSheetDate(batch.mfd),
          quantity: batch.quantity,
          mrp: isSample ? "0" : batchInfo.mrp,
        });
      }
    }

    const order = {
      orderId: `CUSTOM-${Date.now()}`,
      createdAt: new Date().toISOString(),
      customerName: name,
      customerPhone: phone || "",
      shippingAddress: { address1: address, province: state },
      orderType: type,
      totalOrdersCount: items.reduce((sum, i) => sum + i.quantity, 0),
      totalPrice: isSample ? 0 : undefined, // undefined -> generateChallanPdf sums line items
    };

    const pdfPath = await generateChallanPdf(order, enrichedLineItems, OUTPUT_DIR);
    res.json({ url: `/files/${path.basename(pdfPath)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TTP dashboard listening on port ${PORT}`));

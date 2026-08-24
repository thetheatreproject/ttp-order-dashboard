require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { getOrderById, listRecentOrders } = require("./shopify");
const { getOrderById: getAmazonOrderById, listRecentOrders: listRecentAmazonOrders } = require("./amazon");
const { handleWebhook: handleCredWebhook, getOrderById: getCredOrderById, listRecentOrders: listRecentCredOrders } = require("./cred");
const { deductStock, listProductsForDropdown, resolveWebsiteProduct, resolveCredSku } = require("./masterSheet");
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
        const mapping = await resolveWebsiteProduct(li.title);
        if (!mapping) {
          return res.status(422).json({
            error: `"${li.title}" has no entry in the Website Product Mapping tab — add it before generating this challan (Website Product Name, Base Product Name, Units Per Pack).`,
          });
        }
        const baseQuantityNeeded = li.quantity * mapping.unitsPerPack;
        const batchInfo = await deductStock(
          mapping.baseProductName,
          baseQuantityNeeded,
          mapping.grammage,
          mapping.mrp
        );
        enrichedLineItems.push({
          ...li,
          ...batchInfo,
          // Show what was actually sold (e.g. "Pack of 10") on the challan,
          // but the batch/stock info reflects the real base units deducted.
          title: li.title,
          quantity: baseQuantityNeeded,
        });
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
        const mapping = await resolveWebsiteProduct(li.title);
        if (!mapping) {
          return res.status(422).json({
            error: `"${li.title}" has no entry in the Website Product Mapping tab — add it before generating this challan (Website Product Name, Base Product Name, Units Per Pack).`,
          });
        }
        const baseQuantityNeeded = li.quantity * mapping.unitsPerPack;
        const batchInfo = await deductStock(
          mapping.baseProductName,
          baseQuantityNeeded,
          mapping.grammage,
          mapping.mrp
        );
        enrichedLineItems.push({
          ...li,
          ...batchInfo,
          title: li.title,
          quantity: baseQuantityNeeded,
        });
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
        for (const component of components) {
          const baseQuantityNeeded = li.quantity * component.unitsPerPack;
          const mrpValue = parseFloat(String(component.mrp).replace(/[^0-9.]/g, "")) || 0;

          if (mrpValue === 0) {
            // MRP of 0 marks a non-priced item (freebie, gift card, coupon)
            // — these live in the "Extra" category tab, which has no
            // MRP/Grammage columns, so deduct by product name only rather
            // than passing grammage/mrp filters that would never match.
            const batchInfo = await deductStock(component.baseProductName, baseQuantityNeeded);
            enrichedLineItems.push({
              ...li,
              ...batchInfo,
              title: batchInfo.productName,
              quantity: baseQuantityNeeded,
              mrp: "0",
            });
            continue;
          }

          const batchInfo = await deductStock(
            component.baseProductName,
            baseQuantityNeeded,
            component.grammage,
            component.mrp
          );
          enrichedLineItems.push({
            ...li,
            ...batchInfo,
            title: batchInfo.productName,
            quantity: baseQuantityNeeded,
          });
        }
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
      enrichedLineItems.push({
        title: item.productName,
        quantity: item.quantity,
        ...batchInfo,
        mrp: isSample ? "0" : batchInfo.mrp,
      });
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

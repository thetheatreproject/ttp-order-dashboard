require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { getOrderById, listRecentOrders } = require("./shopify");
const { deductStock, listProductsForDropdown, resolveWebsiteProduct } = require("./masterSheet");
const { generateChallanPdf } = require("./generateChallan");
const { generateInvoicePdf } = require("./generateInvoice");
const { getPreviousChallan, recordChallan } = require("./challanLog");

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

// ---- Shopify order list, with download status per order ----
app.get("/api/shopify/orders", async (req, res) => {
  try {
    const orders = await listRecentOrders(25);
    const withStatus = orders.map((o) => ({
      ...o,
      downloaded: !!getPreviousChallan(`shopify:${o.orderId}`),
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
    const previous = getPreviousChallan(logKey);
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
      recordChallan(logKey, enrichedLineItems);
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
    const { name, address, state, type, items } = req.body;
    if (!name || !address || !type || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const isSample = type.toLowerCase() === "sample";
    const enrichedLineItems = [];
    for (const item of items) {
      const batchInfo = await deductStock(item.productName, item.quantity);
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

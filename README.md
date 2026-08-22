# TTP order dashboard

Start screen → Dashboard (Shopify / Amazon / CRED / Custom challan) → order
lists and challan generation, all reading stock from your master inventory
Google Sheet.

## What's built in this version

- **Start screen** → Dashboard with a Shopify tile (live new-order count)
- **Shopify tab**: live order list, green/red dot per order (not
  downloaded / already downloaded), Challan button per order
- **Custom challan**: form with name, address, state, type (Sample/Paid),
  category → product dropdowns pulled live from the master sheet, quantity
  per row, add more rows, auto-totaling (Sample always totals Rs 0)
- **Master sheet integration**: reads all 5 category tabs (Popcorn, Kettle
  Cooked Chips, Air Popped Chips, Krinkle Cut Chips, Nachos), matches
  products by exact name, deducts stock from the lowest-Priority batch
  first, splits across batches if one alone doesn't cover the quantity
- **Idempotent Shopify downloads**: stock only deducts on the first challan
  download per order; re-downloads reuse the recorded batch data

## Not yet built (next steps)

- **Amazon tab** — tile shows "coming soon"; needs the Windsor.ai SP-API
  wiring for order listing
- **CRED tab** — tile shows "coming soon"; needs PDF upload + parsing once
  you send a sample invoice
- **Challan No / Dispatch / Verified By / Logistic Partner** — still blank
  on generated challans, same as before; these are normally filled by hand

## 1. Set up the master Google Sheet

Convert your `Master_File_Office_Inventory.xlsx` into a Google Sheet with
the same 5 tabs and column headers exactly as in the original file:
`Sr. No | Product Type | Product Name | Product Mrp | Product Grammage |
Batch Number | MFD | EXP | Quantity | Priority` (Popcorn tab also has an
EAN Code column — that's fine, it's ignored).

Share the sheet with your Google service account's email as **Editor**
(needed to write stock deductions back). Copy the sheet ID from its URL
into `MASTER_SHEET_ID` in `.env`.

## 2. Shopify + webhook setup

Same as before — Admin API token with `read_orders` scope, and a webhook
(Settings → Notifications → Webhooks → Order creation) pointing at
`https://your-domain.com/webhooks/orders-create`, with the signing secret
in `SHOPIFY_WEBHOOK_SECRET`.

## 3. Install and run

```bash
cd ttp-dashboard
npm install
cp .env.example .env
nano .env   # fill in real values
```

Place your Google service account JSON key in the project root
(`service-account.json`, or point `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` at it).

```bash
npm install -g pm2
pm2 start server.js --name ttp-dashboard
pm2 save
```

Put this behind Nginx/Caddy with HTTPS, same as discussed for the earlier
WhatsApp bot and dashboard builds.

## Important notes

- **Product matching is by exact name.** If a Shopify product title doesn't
  match the master sheet's Product Name exactly, the challan generation
  will fail with a clear "not found" error rather than silently picking the
  wrong item — but this means titles need to stay in sync between Shopify
  and the sheet.
- **Stock deduction is NOT rolled back automatically** if a multi-item
  order fails partway through (e.g. item 2 has insufficient stock after
  item 1 already deducted). This is the same flagged risk as the earlier
  build — worth hardening before real volume.
- Tested against a mock of the real column layout (multi-batch products,
  priority ordering, insufficient stock, product-not-found) — all passing.
  Not yet tested against the live Google Sheet or live Shopify data.

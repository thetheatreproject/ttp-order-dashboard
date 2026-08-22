const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "data", "challan-log.json");

function ensureLogFile() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "{}");
}

function loadLog() {
  ensureLogFile();
  return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  ensureLogFile();
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

/**
 * Returns the previously-recorded enriched line items (with batch numbers
 * already assigned) for this order, or null if a challan has never been
 * generated for it before.
 */
function getPreviousChallan(orderId) {
  const log = loadLog();
  return log[orderId] || null;
}

/**
 * Records that a challan was generated for this order, along with the
 * exact enriched line items (batch numbers etc.) that were used — so any
 * future re-download reuses the same data instead of touching stock again.
 */
function recordChallan(orderId, enrichedLineItems) {
  const log = loadLog();
  log[orderId] = {
    generatedAt: new Date().toISOString(),
    lineItems: enrichedLineItems,
  };
  saveLog(log);
}

module.exports = { getPreviousChallan, recordChallan };

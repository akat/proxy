// Lightweight Expo push proxy for offloading push sends from the ESP32.
// - Receives POST /push with JSON body.
// - Queues messages and sends sequentially to Expo with configurable spacing.
// - Default spacing: 20s between messages, 3s stagger between devices.

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 20000);
const STAGGER_MS = Number(process.env.STAGGER_MS || 3000);
const EXPO_ENDPOINT = process.env.EXPO_ENDPOINT || "https://exp.host/--/api/v2/push/send";

const queue = [];
let sending = false;
let lastSent = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeTokens(to) {
  if (!to) return [];
  if (Array.isArray(to)) return to.filter(Boolean);
  return [to];
}

async function sendToExpo(token, payload) {
  const body = JSON.stringify({ ...payload, to: token });
  try {
    const res = await fetch(EXPO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      body,
    });

    const status = res.status;
    const text = await res.text();
    console.log(`Expo response ${status} for token ${token.substring(0, 20)}...`);
    if (status >= 500 || status === 429) {
      console.warn(`Expo backoff suggested (status ${status})`);
    }
    if (text && text.length < 512) {
      console.log(`Body: ${text}`);
    }
  } catch (err) {
    console.error(`Expo send failed for ${token.substring(0, 20)}...`, err.message);
  }
}

async function processQueue() {
  if (sending) return;
  sending = true;

  while (queue.length > 0) {
    const { token, payload } = queue.shift();

    // Enforce minimum interval between sends
    const waitMs = Math.max(0, lastSent + MIN_INTERVAL_MS - Date.now());
    if (waitMs > 0) {
      await delay(waitMs);
    }

    await sendToExpo(token, payload);
    lastSent = Date.now();

    // Stagger between devices
    if (STAGGER_MS > 0 && queue.length > 0) {
      await delay(STAGGER_MS);
    }
  }

  sending = false;
}

function enqueue(tokens, payload) {
  for (const token of tokens) {
    queue.push({ token, payload });
  }
  processQueue().catch((err) => console.error("Queue error", err));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 16) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok", queued: queue.length });
  }

  if (req.method === "POST" && url.pathname === "/push") {
    try {
      const body = await parseBody(req);
      const tokens = normalizeTokens(body.to);
      if (tokens.length === 0) {
        return sendJson(res, 400, { error: "Missing 'to' token(s)" });
      }
      if (!body.title || !body.body) {
        return sendJson(res, 400, { error: "Missing 'title' or 'body'" });
      }

      const payload = {
        title: body.title,
        body: body.body,
        data: body.data || {},
        sound: body.sound || "default",
        channelId: body.channelId || "default",
        priority: "high",
      };

      enqueue(tokens, payload);
      return sendJson(res, 202, { queued: tokens.length });
    } catch (err) {
      console.error("Failed to handle /push", err);
      return sendJson(res, 400, { error: err.message });
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Expo push proxy listening on port ${PORT}`);
  console.log(`Expo endpoint: ${EXPO_ENDPOINT}`);
  console.log(`Min interval: ${MIN_INTERVAL_MS} ms, device stagger: ${STAGGER_MS} ms`);
});

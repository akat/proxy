// Lightweight push proxy for offloading push sends from the ESP32.
// - Receives POST /push with JSON body.
// - Android tokens (ExponentPushToken[...]) -> Expo push service.
// - iOS tokens, wrapped as ExponentPushToken[apns:<hex>], -> Apple APNs directly.
//
// Why APNs directly for iOS: the Expo push service does NOT deliver custom
// notification sounds to iOS (it only honors default/null/critical-object). To play
// a custom sound that still respects the silent switch, iOS pushes must go straight
// to APNs with `aps.sound` set to the bundled CAF file. The token is wrapped so it
// passes the ESP32's `ExponentPushToken[` validation without firmware changes; this
// proxy unwraps the `apns:` form and routes it to APNs.

const http = require("http");
const http2 = require("http2");
const crypto = require("crypto");
const fs = require("fs");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const EXPO_ENDPOINT = process.env.EXPO_ENDPOINT || "https://exp.host/--/api/v2/push/send";

// --- APNs configuration (token-based auth with a .p8 key) ---
const APNS_HOST = process.env.APNS_HOST || "api.push.apple.com";
const APNS_KEY_ID = process.env.APNS_KEY_ID || "";
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || "";
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.akat78.sixpack";
const APNS_KEY_FILE = process.env.APNS_KEY_FILE || "";
const APNS_KEY_INLINE = process.env.APNS_KEY || ""; // optional inline PEM (\n-escaped)

let APNS_KEY_PEM = "";
try {
  if (APNS_KEY_FILE) {
    APNS_KEY_PEM = fs.readFileSync(APNS_KEY_FILE, "utf8");
  } else if (APNS_KEY_INLINE) {
    APNS_KEY_PEM = APNS_KEY_INLINE.replace(/\\n/g, "\n");
  }
} catch (err) {
  console.error("Failed to read APNs key:", err.message);
}
const APNS_ENABLED = !!(APNS_KEY_PEM && APNS_KEY_ID && APNS_TEAM_ID);

const APNS_WRAP = /^ExponentPushToken\[apns:([0-9a-fA-F]+)\]$/;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// APNs provider tokens are valid up to 60 minutes; reuse and refresh well before that.
let apnsJwt = null;
let apnsJwtAt = 0;
function getApnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwt && now - apnsJwtAt < 3000) return apnsJwt;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: now }));
  const input = `${header}.${claims}`;
  const sig = crypto.sign("SHA256", Buffer.from(input), {
    key: APNS_KEY_PEM,
    dsaEncoding: "ieee-p1363", // JWS wants raw r||s, not DER
  });
  apnsJwt = `${input}.${base64url(sig)}`;
  apnsJwtAt = now;
  return apnsJwt;
}

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
    console.log(`Expo response ${status} for token ${token}`);
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

function sendApns(deviceToken, { title, body, data, sound }) {
  return new Promise((resolve) => {
    if (!APNS_ENABLED) {
      console.error("APNs not configured (need APNS_KEY_FILE/APNS_KEY_ID/APNS_TEAM_ID) - skipping iOS push");
      return resolve();
    }
    // Plain string sound = a normal (non-critical) sound, so it still respects the
    // device's silent switch and Focus modes.
    const aps = { alert: { title, body }, sound: sound || "default" };
    const payload = JSON.stringify({ aps, ...(data || {}) });

    const client = http2.connect(`https://${APNS_HOST}`);
    client.on("error", (err) => {
      console.error("APNs connection error:", err.message);
      resolve();
    });
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${getApnsJwt()}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    let status = 0;
    let respData = "";
    req.on("response", (headers) => {
      status = headers[":status"];
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      respData += chunk;
    });
    req.on("end", () => {
      console.log(`APNs response ${status} for device ${deviceToken.substring(0, 12)}... ${respData || ""}`);
      client.close();
      resolve();
    });
    req.on("error", (err) => {
      console.error("APNs request error:", err.message);
      try {
        client.close();
      } catch (e) {}
      resolve();
    });
    req.write(payload);
    req.end();
  });
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
    return sendJson(res, 200, { status: "ok", apns: APNS_ENABLED });
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

      // iOS needs the bundled CAF (a WAV won't play). The source may still send the
      // legacy .wav name. Android takes the sound from its notification channel, so its
      // payload sound is left EXACTLY as received - only the iOS/APNs path is remapped.
      const rawSound = body.sound || "default";
      const isAlarm = rawSound === "geofence_alarm.wav" || rawSound === "geofence_alarm.caf";
      const data = body.data && typeof body.data === "object" ? body.data : {};

      await Promise.all(
        tokens.map((t) => {
          const m = APNS_WRAP.exec(t);
          if (m) {
            return sendApns(m[1], {
              title: body.title,
              body: body.body,
              data,
              sound: isAlarm ? "geofence_alarm.caf" : rawSound,
            });
          }
          return sendToExpo(t, {
            title: body.title,
            body: body.body,
            data,
            sound: rawSound,
            channelId: body.channelId || "default",
            priority: "high",
          });
        })
      );
      return sendJson(res, 200, { sent: tokens.length });
    } catch (err) {
      console.error("Failed to handle /push", err);
      return sendJson(res, 400, { error: err.message });
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Push proxy listening on port ${PORT}`);
  console.log(`Expo endpoint: ${EXPO_ENDPOINT}`);
  console.log(`APNs: ${APNS_ENABLED ? `enabled (topic ${APNS_BUNDLE_ID}, host ${APNS_HOST})` : "disabled"}`);
});

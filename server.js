// Clone Drone Twitch Spawn Mod — Relay Server
// Deploy to Railway: https://railway.app

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;

const rooms = new Map();

function getRoom(channel) {
  if (!rooms.has(channel))
    rooms.set(channel, { mod: null, viewers: new Set(), lastState: null, lastConfig: null });
  return rooms.get(channel);
}

function cleanupRoom(channel) {
  const room = rooms.get(channel);
  if (room && !room.mod && room.viewers.size === 0)
    rooms.delete(channel);
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN)
    try { ws.send(JSON.stringify(obj)); } catch {}
}

function broadcast(viewers, obj) {
  const msg = JSON.stringify(obj);
  for (const v of viewers)
    if (v.readyState === WebSocket.OPEN)
      try { v.send(msg); } catch {}
}

// ── HTTP health check ──────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  let out = "Clone Drone Relay — OK\n\nRooms:\n";
  for (const [ch, r] of rooms)
    out += `  ${ch}: mod=${r.mod ? "online" : "offline"}, viewers=${r.viewers.size}\n`;
  res.end(out);
});

// ── WebSocket ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const url     = new URL(req.url, "http://localhost");
  const role    = url.pathname.replace(/^\//, "").toLowerCase();
  const channel = (url.searchParams.get("channel") || "").toLowerCase().trim();

  if (!channel || (role !== "mod" && role !== "viewer")) {
    ws.close(1008, "Use /mod?channel=name or /viewer?channel=name");
    return;
  }

  if (role === "mod") {
    const expected = process.env.RELAY_SECRET || "";
    if (expected && url.searchParams.get("secret") !== expected) {
      ws.close(1008, "Invalid secret");
      return;
    }
  }

  const room = getRoom(channel);
  console.log(`[${channel}] ${role} connected`);

  // ── MOD ───────────────────────────────────────────────────────
  if (role === "mod") {
    if (room.mod?.readyState === WebSocket.OPEN) room.mod.close(1000, "Replaced");
    room.mod = ws;
    broadcast(room.viewers, { type: "modOnline" });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "config") {
          room.lastConfig = msg;
          broadcast(room.viewers, msg);
        } else if (msg.type === "state") {
          room.lastState = msg;
          broadcast(room.viewers, msg);
        } else if (msg.type === "coinUpdate" || msg.type === "response") {
          // Forward to the specific viewer only
          for (const v of room.viewers)
            if (v._username === msg.username) { send(v, msg); break; }
        } else if (msg.type === "coinsSnapshot") {
          for (const v of room.viewers) {
            if (!v._username || !msg.coins) continue;
            const coins = msg.coins[v._username];
            if (coins !== undefined)
              send(v, { type: "coinUpdate", username: v._username, coins });
          }
        } else {
          broadcast(room.viewers, msg);
        }
      } catch {}
    });

    ws.on("close", () => {
      console.log(`[${channel}] Mod disconnected`);
      room.mod = null;
      room.lastState = null;
      broadcast(room.viewers, { type: "modOffline" });
      cleanupRoom(channel);
    });

    ws.on("error", err => console.error(`[${channel}] Mod error: ${err.message}`));
  }

  // ── VIEWER ────────────────────────────────────────────────────
  else {
    room.viewers.add(ws);

    send(ws, {
      type:         "welcome",
      hasActiveMod: room.mod?.readyState === WebSocket.OPEN,
      lastConfig:   room.lastConfig,
      lastState:    room.lastState
    });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === "identify") {
          ws._username = (msg.username || "").toLowerCase();
          if (room.mod?.readyState === WebSocket.OPEN)
            send(room.mod, { type: "viewerJoined", username: ws._username });
          return;
        }

        // Normal viewer actions — forward to mod
        const viewerAllowed = ["spawn", "clone", "bettier", "betkiller", "suggest"];
        if (viewerAllowed.includes(msg.type)) {
          if (room.mod?.readyState === WebSocket.OPEN) {
            msg.username = ws._username || msg.username || "unknown";
            send(room.mod, msg);
          } else {
            send(ws, { type: "error", message: "Streamer is not in Twitch mode right now." });
          }
          return;
        }

        // Broadcaster-only command (give/set coins, etc.)
        // Security: only the channel owner's viewer session can send this.
        if (msg.type === "streamerCommand") {
          if (!ws._username || ws._username !== channel) {
            send(ws, { type: "error", message: "Only the broadcaster can use streamer commands." });
            return;
          }
          if (room.mod?.readyState === WebSocket.OPEN) {
            msg.username = ws._username;
            send(room.mod, msg);
          } else {
            send(ws, { type: "error", message: "Mod is not connected." });
          }
          return;
        }

      } catch {}
    });

    ws.on("close", () => { room.viewers.delete(ws); cleanupRoom(channel); });
    ws.on("error", ()  => room.viewers.delete(ws));
  }
});

httpServer.listen(PORT, () => console.log(`Clone Drone Relay on port ${PORT}`));

// ── Keep-alive: prevent Railway free tier from sleeping ───────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : null;

if (SELF_URL) {
  const https = require("https");
  setInterval(() => {
    https.get(SELF_URL, res => {
      console.log(`[Keepalive] pinged ${SELF_URL} -> ${res.statusCode}`);
    }).on("error", err => {
      console.warn(`[Keepalive] ping failed: ${err.message}`);
    });
  }, 4 * 60 * 1000);
  console.log(`[Keepalive] Enabled — will ping ${SELF_URL} every 4 min`);
} else {
  console.log("[Keepalive] RAILWAY_PUBLIC_DOMAIN not set — keepalive disabled.");
  console.log("[Keepalive] Set it in Railway -> Variables to enable auto-ping.");
}

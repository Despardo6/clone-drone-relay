// Clone Drone Twitch Spawn Mod — Relay Server
// Deploy to Railway: https://railway.app
//
// Rooms keyed by streamer Twitch username (lowercase).
// Each room has ONE mod connection and N viewer connections.

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;

// rooms[channel] = { mod, viewers, lastState, lastConfig }
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

// ── HTTP (health check for Railway) ───────────────────────────
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

  // Optional secret to prevent random mods connecting
  if (role === "mod") {
    const expected = process.env.RELAY_SECRET || "";
    if (expected && url.searchParams.get("secret") !== expected) {
      ws.close(1008, "Invalid secret");
      return;
    }
  }

  const room = getRoom(channel);
  console.log(`[${channel}] ${role} connected`);

  // ── MOD ──────────────────────────────────────────────────────
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
          // Forward to specific viewer only
          for (const v of room.viewers)
            if (v._username === msg.username) { send(v, msg); break; }
        } else if (msg.type === "coinsSnapshot") {
          // Send each viewer only their own coin balance extracted from the snapshot
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

    // Send current state immediately so viewer doesn't wait for next push
    send(ws, {
      type:       "welcome",
      hasActiveMod: room.mod?.readyState === WebSocket.OPEN,
      lastConfig: room.lastConfig,
      lastState:  room.lastState
    });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === "identify") {
          ws._username = (msg.username || "").toLowerCase();
          // Ask mod to push this viewer's coin balance
          if (room.mod?.readyState === WebSocket.OPEN)
            send(room.mod, { type: "viewerJoined", username: ws._username });
          return;
        }

        const allowed = ["spawn", "clone", "bettier", "betkiller"];
        if (allowed.includes(msg.type)) {
          if (room.mod?.readyState === WebSocket.OPEN) {
            msg.username = ws._username || msg.username || "unknown";
            send(room.mod, msg);
          } else {
            send(ws, { type: "error", message: "Streamer is not in Twitch mode right now." });
          }
        }
      } catch {}
    });

    ws.on("close", () => { room.viewers.delete(ws); cleanupRoom(channel); });
    ws.on("error", ()  => room.viewers.delete(ws));
  }
});

httpServer.listen(PORT, () => console.log(`Clone Drone Relay on port ${PORT}`));

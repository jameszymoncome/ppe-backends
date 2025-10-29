// server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ================== CONFIG ==================
const PORT = process.env.PORT || 8080;

// ================== EXPRESS ==================
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ================== HEALTH CHECK (Render requirement) ==================
app.get("/", (req, res) => {
  res.send("✅ WebSocket server is running on Render.");
});

// ================== SERVER & WS ==================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ================== STATE MAPS ==================
const clients = new Map();        // Tracks connected clients (web + esp)
const espBySsid = new Map();      // Tracks ESP32 by SSID
const frontendByUserId = new Map(); // Tracks frontends by user ID

// ================== WEBSOCKET HANDLERS ==================
wss.on("connection", (ws) => {
  console.log("🔗 New WebSocket client connected");

  ws.isAlive = true;
  ws.clientType = "unknown";

  // --- Heartbeat pong ---
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // --- Handle messages ---
  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    // --- Handle reconnect / new ESP32 ---
    if (data.type === "reconnect") {
      const oldInfo = espBySsid.get(data.ssid);
      if (!oldInfo) console.log(`🆕 New ESP32 connected: ${data.ssid}`);
      else console.log(`♻️ ESP32 reconnected: ${data.ssid}`);

      espBySsid.set(data.ssid, {
        ws,
        userID: oldInfo?.userID || data.userID || "",
        status: "online",
        last: Date.now(),
      });

      // Remove duplicates
      clients.forEach((info, client) => {
        if (info.ssid === data.ssid && client !== ws) {
          clients.delete(client);
          client.terminate();
        }
      });

      clients.set(ws, { last: Date.now(), ssid: data.ssid });

      const espInfo = espBySsid.get(data.ssid);
      if (espInfo?.ws?.readyState === WebSocket.OPEN) {
        espInfo.ws.send(
          JSON.stringify({
            type: "connection",
            action: "sayHello",
            ssid: data.ssid,
            userID: espInfo.userID,
          })
        );
        console.log(`📤 Sent command to ESP32 (${data.ssid})`);
      }
    }

    // --- Heartbeat ---
    if (data.type === "heartbeat") {
      ws.clientType = "esp";
      clients.set(ws, { last: Date.now(), ssid: data.ssid });
      espBySsid.set(data.ssid, {
        ws,
        userID: espBySsid.get(data.ssid)?.userID || null,
        status: "online",
        last: Date.now(),
      });

      console.log(`✅ ESP32 heartbeat received: ${data.ssid}`);

      const msg = JSON.stringify({
        type: "status",
        status: "online",
        ssid: data.ssid,
        msg: "ESP32 heartbeat received",
      });

      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN)
          client.send(msg);
      });
      return;
    }

    // --- NFC Event ---
    if (data.type === "nfc") {
      console.log(`📡 NFC tag detected from user ${data.userID}`);
      const msg = JSON.stringify({
        type: "nfcEvent",
        uid: data.uid,
        message: "NFC tag detected",
      });
      const frontend = frontendByUserId.get(data.userID);
      if (frontend?.ws?.readyState === WebSocket.OPEN) frontend.ws.send(msg);
    }

    // --- Frontend user registering (for targeted push) ---
    if (data.type === "accStatus") {
      frontendByUserId.set(data.userID, { ws });
      ws.clientType = "frontend";
      console.log(`💻 Frontend registered for user ${data.userID}`);
    }
  });

  // --- Handle disconnect ---
  ws.on("close", () => {
    console.log("🔌 WebSocket client disconnected");
    const info = clients.get(ws);
    if (info?.ssid) {
      const espInfo = espBySsid.get(info.ssid);
      if (espInfo)
        espBySsid.set(info.ssid, {
          ws: null,
          status: "offline",
          userID: espInfo.userID || "",
        });
    }
    clients.delete(ws);
  });
});

// ================== KEEPALIVE ==================
setInterval(() => {
  const now = Date.now();
  clients.forEach((data, ws) => {
    if (now - data.last > 15000) {
      console.log(`❌ ESP32 (${data.ssid}) not responding, marking offline`);

      const offlineMsg = JSON.stringify({
        type: "status",
        status: "offline",
        ssid: data.ssid,
        msg: "ESP32 not responding",
      });

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(offlineMsg);
      });

      ws.terminate();
      clients.delete(ws);

      const espInfo = espBySsid.get(data.ssid);
      if (espInfo)
        espBySsid.set(data.ssid, {
          ws: null,
          status: "offline",
          userID: espInfo.userID || "",
        });
    }
  });
}, 5000);

// ================== START SERVER ==================
server.listen(PORT, () => {
  console.log(`🚀 ESP32 WebSocket server running on port ${PORT}`);
});

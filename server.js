// ================== IMPORTS ==================
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ================== CONFIG ==================
const PORT = process.env.PORT || 8080;
const app = express();

app.use(cors());
app.use(bodyParser.json());

// ================== HEALTH CHECK (Render requirement) ==================
app.get("/", (req, res) => {
  res.send("✅ WebSocket + Express server is running on Render.");
});

// ================== SERVER & WS ==================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ================== STATE MAPS ==================
const clients = new Map();        // Tracks all connected sockets
const espBySsid = new Map();      // ESP32 devices
const frontendByUserId = new Map(); // Frontend users

// ================== UTILITIES ==================
function findSsidByUserId(userId) {
  for (const [ssid, info] of espBySsid.entries()) {
    if (info.userID === userId) return { ssid, ...info };
  }
  return null;
}

// ================== WEBSOCKET HANDLERS ==================
wss.on("connection", (ws) => {
  console.log("🔗 New WebSocket client connected");
  ws.isAlive = true;
  ws.clientType = "unknown";

  // --- Heartbeat pong handler ---
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // --- Incoming messages ---
  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    // 1️⃣ ESP Reconnect
    if (data.type === "reconnect") {
      const oldInfo = espBySsid.get(data.ssid);
      console.log(
        oldInfo
          ? `♻️ ESP32 reconnected: ${data.ssid}`
          : `🆕 New ESP32 connected: ${data.ssid}`
      );

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

      // Send back confirmation
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
        console.log(`📤 Sent handshake to ESP32 (${data.ssid})`);
      }
    }

    // 2️⃣ ESP Heartbeat
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

    // 3️⃣ Frontend Registration
    if (data.type === "accStatus" && data.userID) {
      frontendByUserId.set(data.userID, { ws, status: "online", last: Date.now() });
      ws.clientType = "frontend";
      console.log(`💻 Frontend registered for user ${data.userID}`);
    }

    // 4️⃣ NFC Event
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

    // 5️⃣ Device Connection Check
    if (data.type === "connection" && data.userID) {
      const device = findSsidByUserId(data.userID);
      const frontend = frontendByUserId.get(data.userID);
      const msg = JSON.stringify({
        type: "deviceConnection",
        deviceName: device?.ssid || "",
        message: device ? "Connected" : "Not connected",
      });

      if (frontend?.ws?.readyState === WebSocket.OPEN) {
        frontend.ws.send(msg);
      }
    }
  });

  // --- Client disconnected ---
  ws.on("close", () => {
    console.log("🔌 WebSocket client disconnected");

    // Mark ESP offline
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

    // Mark frontend offline
    for (const [userID, frontend] of frontendByUserId.entries()) {
      if (frontend.ws === ws) {
        frontendByUserId.set(userID, {
          ...frontend,
          status: "offline",
          lastSeen: Date.now(),
        });
        console.log(`❌ Frontend user ${userID} disconnected`);
      }
    }

    clients.delete(ws);
  });
});

// ================== PING FRONTENDS ==================
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.clientType !== "frontend") return;
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// ================== ESP OFFLINE CHECK ==================
setInterval(() => {
  const now = Date.now();
  clients.forEach((data, ws) => {
    if (now - data.last > 15000) {
      console.log(`❌ ESP32 (${data.ssid}) timed out`);
      const offlineMsg = JSON.stringify({
        type: "status",
        status: "offline",
        ssid: data.ssid,
        msg: "ESP32 timeout",
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
  console.log(`🚀 Server running on port ${PORT}`);
});

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import http from "http";
import { WebSocketServer } from "ws"; // ✅ fixed import

const PORT = process.env.PORT || 8080;

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("✅ WebSocket server is running on Render.");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server }); // ✅ fixed

const clients = new Map();
const espBySsid = new Map();
const frontendByUserId = new Map();

wss.on("connection", (ws) => {
  console.log("🔗 New WebSocket client connected");

  ws.isAlive = true;
  ws.clientType = "unknown";

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {}

    if (data.type === "reconnect") {
      const oldInfo = espBySsid.get(data.ssid);

      if (!oldInfo) {
        console.log(`🆕 New ESP32 connected with SSID: ${data.ssid}`);
      } else {
        console.log(`♻️ ESP32 reconnected with SSID: ${data.ssid}`);
      }

      // Always replace with the new WebSocket
      espBySsid.set(data.ssid, {
        ws,
        userID: oldInfo?.userID || data.userID || "",
        stats: "online",
        last: Date.now(),
      });

      // Also replace inside clients map (remove old ws)
      clients.forEach((info, client) => {
        if (info.ssid === data.ssid && client !== ws) {
          clients.delete(client); // remove old reference
          client.terminate();
        }
      });

      clients.set(ws, { last: Date.now(), ssid: data.ssid });

      // Send confirmation
      const espInfo = espBySsid.get(data.ssid);
      if (espInfo && espInfo.ws.readyState === WebSocket.OPEN) {
        const message = JSON.stringify({
          type: "connection",
          action: "sayHello",
          ssids: data.ssid,
          userID: espInfo.userID
        });
        espInfo.ws.send(message);
        console.log(`📤 Sent command to ESP32 (${data.ssid})`);
      }
    }

    if (data.type === "heartbeat"){
      ws.clientType = "esp";

      clients.set(ws, { last: Date.now(), ssid: data.ssid });

      const oldInfo = espBySsid.get(data.ssid);
      espBySsid.set(data.ssid, {
        ws,
        userID: oldInfo?.userID || null, // save userID if you know it
        stats: "online",
        last: Date.now(),
      });

      console.log(`✅ ESP32 heartbeat received (SSID: ${data.ssid})`);

      const onlineMsg = JSON.stringify({
        type: "status",
        status: "online",
        ssid: data.ssid,
        msg: "ESP32 heartbeat received",
      });

      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(onlineMsg);
        }
      });
      return;
    }

    if (data.type === "accStatus" && data.userID) {
      ws.clientType = "frontend";
      const oldInfo = frontendByUserId.get(data.userID);

      frontendByUserId.set(data.userID, {
        ws,
        status: "online",
        last: Date.now()
      });

      if (!oldInfo) {
        console.log(`✅ New user added: ${data.userID}`);
      } else {
        console.log(`♻️ User reconnected: ${data.userID}`);
      }
    }

    if (data.type === "logout" && data.userID) {
      const userInfo = frontendByUserId.get(data.userID);
      if (userInfo) {
        frontendByUserId.set(data.userID, {
          ...userInfo,
          status: "offline",
          last: Date.now(),
        });
        console.log(`🚪 User ${data.userID} set to OFFLINE`);
      }
    }

    if (data.type === "deviceSelected"){
      console.log(`📱 User selected device: ${data.deviceName} (UserID: ${data.userID})`);

      const espInfo = espBySsid.get(data.deviceName);
      if (espInfo && espInfo.userID){
        const accInfo = frontendByUserId.get(espInfo.userID);
        if (accInfo.status === "online"){
          console.log(`📤 The device name is already connected (${data.deviceName})`);
          const msg = JSON.stringify({
            type: "deviceStatus",
            deviceName: data.deviceName,
            message: "The device is already connected",
          });

          // Send only to that specific frontend's WebSocket
          // if (accInfo.ws && accInfo.ws.readyState === WebSocket.OPEN) {
          //   accInfo.ws.send(msg);
          // }
          const frontend = frontendByUserId.get(data.userID);
          if (frontend && frontend.ws.readyState === 1) {
            frontend.ws.send(msg);
          } else {
            console.warn(`⚠️ No active frontend for userID ${data.userID}`);
          }
        }
        else {
          if (espInfo && espInfo.ws && espInfo.ws.readyState === WebSocket.OPEN) {
            espInfo.userID = data.userID; // update userID
            espBySsid.set(data.deviceName, espInfo);

            console.log(`✅ Updated ESP (${data.deviceName}) with userID: ${espInfo.userID}`);

            const msg = JSON.stringify({
              type: "command",
              userID: data.userID,
              deviceName: data.deviceName,
              message: "Device successfully linked to account."
            });

            // ✅ Send to ESP device
            if (espInfo.ws && espInfo.ws.readyState === WebSocket.OPEN) {
              espInfo.ws.send(msg);
              console.log(`📤 Sent command to ESP32 (${data.deviceName})`);
            } else {
              console.log(`⚠️ ESP32 connection is not open for ${data.deviceName}`);
            }

            // ✅ Send to React frontend
            const accInfo = frontendByUserId.get(data.userID);
            if (accInfo && accInfo.ws && accInfo.ws.readyState === WebSocket.OPEN) {
              accInfo.ws.send(msg);
              console.log(`📤 Sent command to React frontend for userID: ${data.userID}`);
            } else {
              console.log(`⚠️ No active frontend WebSocket for userID: ${data.userID}`);
            }

          } else {
            console.log(`⚠️ No ESP32 connected with SSID: ${data.deviceName}`);
          }
        }
      }
      else {
        if (espInfo && espInfo.ws && espInfo.ws.readyState === WebSocket.OPEN) {
          espInfo.userID = data.userID; // update userID
          espBySsid.set(data.deviceName, espInfo);

          console.log(`✅ Updated ESP (${data.deviceName}) with userID: ${espInfo.userID}`);

          // espInfo.ws.send(JSON.stringify({
          //   type: "command",
          //   userID: data.userID
          // }));

          // console.log(`📤 Sent command to ESP32 (${data.deviceName})`);

          const msg = JSON.stringify({
            type: "command",
            userID: data.userID,
            deviceName: data.deviceName,
            message: "Device successfully linked to account."
          });

          // ✅ Send to ESP device
          if (espInfo.ws && espInfo.ws.readyState === WebSocket.OPEN) {
            espInfo.ws.send(msg);
            console.log(`📤 Sent command to ESP32 (${data.deviceName})`);
          } else {
            console.log(`⚠️ ESP32 connection is not open for ${data.deviceName}`);
          }

          // ✅ Send to React frontend
          const accInfo = frontendByUserId.get(data.userID);
          if (accInfo && accInfo.ws && accInfo.ws.readyState === WebSocket.OPEN) {
            accInfo.ws.send(msg);
            console.log(`📤 Sent command to React frontend for userID: ${data.userID}`);
          } else {
            console.log(`⚠️ No active frontend WebSocket for userID: ${data.userID}`);
          }

        } else {
          console.log(`⚠️ No ESP32 connected with SSID: ${data.deviceName}`);
        }
      }


      return;

    }

    if(data.type === "connection"){
      const device = findSsidByUserId(data.userID);

      if (device) {
        console.log(`SSID ${device.ssid} belongs to user ${data.userID} and is ${device.stats}`);
        const msg = JSON.stringify({
          type: "deviceConnection",
          deviceName: device.ssid,
          message: device.stats === "online" ? "Connected" : "Not connected",
        });

        // ✅ Get the frontend WebSocket for this user
        const frontend = frontendByUserId.get(data.userID);

        if (frontend && frontend.ws && frontend.ws.readyState === 1) {
          frontend.ws.send(msg);
        }
        else {
          console.log(`⚠️ No active frontend socket for user ${data.userID}`);
        }
      } else {
        console.log("No device found for this user");

        const msg = JSON.stringify({
          type: "deviceConnection",
          deviceName: "",
          message: "Not connected",
        });

        const frontend = frontendByUserId.get(data.userID);

        if (frontend && frontend.ws && frontend.ws.readyState === 1) {
          frontend.ws.send(msg);
        }
        else {
          console.log(`⚠️ No active frontend socket for user ${data.userID}`);
        }
      }
    }

    if(data.type === "nfc"){
      console.log(`📥 NFC data from ESP: ${data.uid}`);
      const msg = JSON.stringify({
        type: "nfcEvent",
        uid: data.uid,
        message: "NFC tag detected",
      });

      const frontend = frontendByUserId.get(data.userID);
      if (frontend && frontend.ws.readyState === 1) {
        frontend.ws.send(msg);
      } else {
        console.warn(`⚠️ No active frontend for userID ${data.userID}`);
      }
    }

  });

  ws.on("close", () => {
    console.log("🔌 WebSocket client disconnected");

    for (const [userID, info] of frontendByUserId.entries()) {
      if (info.ws === ws) {
        frontendByUserId.set(userID, { 
          ...info,
          status: "offline",
          lastSeen: Date.now()
        });
        console.log(`❌ User disconnected: ${userID} (marked offline)`);

        // Notify others this user is offline
        // const offlineMsg = JSON.stringify({
        //   type: "status",
        //   userID,
        //   status: "offline"
        // });

        // wss.clients.forEach((client) => {
        //   if (client.readyState === WebSocket.OPEN) {
        //     client.send(offlineMsg);
        //   }
        // });
        break;
      }
    }

    const info = clients.get(ws);
    if (info?.ssid) {
      const espInfo = espBySsid.get(info.ssid);
      if (espInfo) {
        // keep userID, just set ws = null
        espBySsid.set(info.ssid, {
          ws: null,
          stats: "offline",
          userID: espInfo.userID || ""
        });
      }
    }
    clients.delete(ws);
  });
});

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
        if (client.readyState === WebSocket.OPEN) {
          client.send(offlineMsg);
        }
      });

      ws.terminate();
      clients.delete(ws);

      // mark offline but keep userID
      const espInfo = espBySsid.get(data.ssid);
      if (espInfo) {
        espBySsid.set(data.ssid, {
          ws: null,
          stats: "offline",
          userID: espInfo.userID || ""
        });
      }
    }
  });
}, 5000);

setInterval(() => {
  wss.clients.forEach((ws) => {
    // ✅ Only ping frontend, not ESP
    if (ws.clientType !== "frontend") return;

    if (!ws.isAlive) {
      // Mark frontend user offline
      for (const [userID, info] of frontendByUserId.entries()) {
        if (info.ws === ws && info.status === "online") {
          frontendByUserId.set(userID, {
            ...info,
            status: "offline",
            lastSeen: Date.now()
          });
          console.log(`⚠️ User lost connection: ${userID}`);

          const msg = JSON.stringify({
            type: "status",
            userID,
            status: "offline"
          });
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
          });
        }
      }
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping(); // 👉 only frontend gets this
  });
}, 15000);

function findSsidByUserId(userId) {
  for (const [ssid, info] of espBySsid.entries()) {
    if (info.userID === userId) {
      return { ssid, ...info }; // return both ssid and stored info
    }
  }
  return null;
}

// ==================== SIGNUP NOTIFY ====================
app.post("/notify-signup", (req, res) => {
  const { fullName, department } = req.body;

  const message = JSON.stringify({
    type: "signup",
    fullName,
    department,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });

  res.json({ success: true });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running (HTTP + WS) on http://localhost:${PORT}`);
});
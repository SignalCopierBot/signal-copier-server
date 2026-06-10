import net from "net";
import http from "http";

const LICENSES = ["LICENSE_CODE_1", "LICENSE_CODE_2", "LICENSE_CODE_3"]; // Replace with your actual license codes. MT5 EA will use one of these to connect to the TCP server.
const TCP_PORT = 6789; // Port for the TCP server to listen on. MT5 EA will connect to this port.
const HTTP_PORT = 2345; // Port for the HTTP API server to listen on. Send POST requests to this port to send messages to connected TCP clients.

const clients = new Map();
let tcpServer = null;
let httpServer = null;

async function handleConnect(socket, license) {
  try {
    license = license?.trim();

    if (!license || !LICENSES.includes(license)) {
      socket.write("CMD_LICENSE_FAIL\n");
      socket.destroy();
      return;
    }
    const existing = clients.get(license);

    // Reject duplicate active connection
    if (existing && existing !== socket && !existing.destroyed && existing.writable) {
      socket.write("CMD_LICENSE_FAIL\n");
      socket.destroy();
      return;
    }

    socket.license = license;
    socket.disconnected = false;
    clients.set(license, socket);
    socket.write("CMD_LICENSE_OK\n");
    console.log(`Client connected: ${license}`);
  } catch (ex) {
    console.error("Handle connect error:", ex);

    try {
      socket.write("CMD_LICENSE_FAIL\n");
    } catch { }

    socket.destroy();
  }
}

async function handleDisconnect(socket) {
  try {
    if (socket.disconnected) {
      return;
    }

    socket.disconnected = true;

    if (!socket.license) {
      if (!socket.destroyed) {
        socket.destroy();
      }
      return;
    }

    const current = clients.get(socket.license);

    // Ignore if a newer socket replaced this one
    if (current !== socket) {
      return;
    }

    clients.delete(socket.license);
    console.log(`Client disconnected: ${socket.license}`);

    if (!socket.destroyed) {
      socket.destroy();
    }
  } catch (ex) {
    console.error("Handle disconnect error:", ex);
  }
}

async function startTcpServer() {
  if (tcpServer) {
    return;
  }

  tcpServer = net.createServer((socket) => {
    socket.license = null;
    socket.disconnected = false;
    socket.buffer = "";
    socket.setEncoding("utf8");
    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);
    socket.setTimeout(30000);

    socket.on("data", async (data) => {
      try {
        socket.buffer += data;

        const messages = socket.buffer.split("\n");
        socket.buffer = messages.pop() || "";

        for (const raw of messages) {
          const message = raw.trim();

          if (!message) {
            continue;
          }

          if (!socket.license) {
            if (!message.startsWith("CMD_LICENSE:")) {
              socket.write("CMD_LICENSE_FAIL\n");
              socket.destroy();
              return;
            }
            const license = message.substring("CMD_LICENSE:".length).trim();

            if (!license) {
              console.warn("No license received");
              socket.write("CMD_LICENSE_FAIL\n");
              socket.destroy();
              return;
            }

            await handleConnect(socket, license);
            continue;
          }

          if (message === "CMD_PING") {
            socket.write("CMD_PONG\n");
            continue;
          }
        }
      } catch (err) {
        console.error("Data processing error:", err);
        handleDisconnect(socket);
      }
    });

    socket.on("end", () => {
      handleDisconnect(socket);
    });

    socket.on("close", () => {
      handleDisconnect(socket);
    });

    socket.on("error", (err) => {
      console.error(`Socket error (${socket.license || "unlicensed"}):`, err.message);
      handleDisconnect(socket);
    });

    socket.on("timeout", () => {
      console.warn(`Socket timeout (${socket.license || "unlicensed"})`);
      handleDisconnect(socket);
    });
  });

  tcpServer.on("error", (err) => {
    console.error("TCP Server error:", err);
  });

  tcpServer.listen(TCP_PORT, () => {
    console.log(`TCP Server listening on port ${TCP_PORT}`);
  });
}


async function startHttpServer() {
  if (httpServer) {
    return;
  }

  httpServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { license, message } = JSON.parse(body);
          if (!license || !message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, message: "License and message are required" }));
          }
          const socket = clients.get(license);
          if (socket && socket.writable) {
            try {
              socket.write(`${message}\n`);
            } catch (err) {
              console.error("Error writing to socket:", err);
            }
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, message: "Client not connected" }));
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "Message sent" }));
        } catch (err) {
          console.error("Error processing HTTP API request:", err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, message: "Invalid JSON" }));
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "Not found" }));
    }
  });
  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP Server listening on port ${HTTP_PORT}`);
  });
  httpServer.on("error", (err) => {
    console.error("HTTP Server error:", err);
  });
}

function gracefulShutdown() {
  console.log("Shutting down TCP server...");

  for (const socket of clients.values()) {
    try {
      if (!socket.destroyed) {
        socket.destroy();
      }
    } catch (err) {
      console.error("Error destroying socket:", err);
    }
  }

  clients.clear();

  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  if (tcpServer) {
    tcpServer.close(() => {
      tcpServer = null;
      console.log("TCP server closed.");
      process.exit(0);
    });

    setTimeout(() => {
      console.warn("Forcing shutdown...");
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

startTcpServer();
startHttpServer();
import net from "net";

const allowedLicenses = [
  "LICENSE_CODE_1",
  "LICENSE_CODE_2",
  "LICENSE_CODE_3",
]; // Replace with your actual license codes. MT5 EA will use one of these to connect to the TCP server.

const tcpPort = 6789; // Port for the TCP server to listen on. MT5 EA will connect to this port. Make sure it's open in your firewall and not used by other applications.
const clients = new Map();
let tcpServer = null;

async function handleConnect(socket, license) {
  try {
    license = license?.trim();

    if (!license || !allowedLicenses.includes(license)) {
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

  tcpServer.listen(tcpPort, () => {
    console.log(`TCP Server listening on port ${tcpPort}`);
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
// Server entry point: Express (HTTP pull/push) + Socket.IO (live "sync now" pings).
// Read top to bottom: imports -> app -> routes -> sockets -> listen.
// Line 1: Load .env first so PORT/DATABASE_URL exist before other modules read them.
import "dotenv/config";
// Line 2-3: Web framework + Node HTTP server (Socket.IO must attach to an http server).
import express from "express";
import { createServer } from "http";
// Line 4: Allows the Expo app (different origin) to call this API.
import cors from "cors";
// Line 5: Real-time layer. We only send tiny "notes-changed" pings;
// the actual note data still travels over HTTP pull/push below.
import { Server } from "socket.io";
// Line 6-7: Our two helpers: the pg pool (health checks) and sync logic.
import { pool } from "./db";
import { pullChanges, pushChanges } from "./sync";

// Line 8: Port Render gives us via env, 3000 for local `npm run dev`.
const PORT = Number(process.env.PORT || 3000);

// Line 9-10: Create the Express app and accept JSON bodies up to 1mb
// (a push with many notes must fit; 1mb is plenty for text notes).
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Line 11-12: Wrap Express in a plain HTTP server, then attach Socket.IO.
// CORS is wide open (*) so any Expo dev client on the LAN can connect.
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Line 13-15: Root route — proves the server is up and shows the client URL.
app.get("/", (_req, res) => {
  res.json({ name: "SyncNote API", status: "running" });
});

// Line 16-22: Health route for Render + debugging.
// It pings Neon with SELECT 1: "connected" means DB reachable.
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error);
    res.status(503).json({ status: "error", database: "disconnected" });
  }
});

// Line 23-27: PULL — the app sends its cursor, we return changes since then.
// Body: { lastPulledAt: number } -> { changes, timestamp }.
app.post("/sync/pull", async (req, res) => {
  try {
    const lastPulledAt = Number(req.body?.lastPulledAt ?? 0);
    res.json(await pullChanges(lastPulledAt));
  } catch (error) {
    console.error("Pull failed:", error);
    res.status(500).json({ error: "pull failed" });
  }
});

// Line 28-37: PUSH — the app uploads local edits, we save + notify others.
// Body: { changes: { notes: { created, updated, deleted } } }.
// After saving, EVERY connected device (except the sender) gets a
// "notes-changed" ping so it pulls immediately instead of polling.
app.post("/sync/push", async (req, res) => {
  try {
    const changes = req.body?.changes;
    if (!changes?.notes) {
      res.status(400).json({ error: "body.changes.notes is required" });
      return;
    }
    await pushChanges(changes);
    req.body?.socketId
      ? io.except(req.body.socketId).emit("notes-changed")
      : io.emit("notes-changed");
    res.json({ ok: true });
  } catch (error) {
    console.error("Push failed:", error);
    res.status(500).json({ error: "push failed" });
  }
});

// Line 38-44: Socket lifecycle. Each app holds ONE socket open.
// - "connection": log it; the socket id lets push() skip echoing back.
// - "disconnect": just log it; the app reconnects by itself.
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// Line 45-47: Start listening immediately (no DB check here).
// If Neon is asleep, /health reports "disconnected" but the server still
// answers — this keeps Render deploys and offline-app debugging simple.
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`SyncNote API running  successfully on port ${PORT}`);
});

import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  createRoom,
  joinRoom,
  selectSeat,
  transferSupervisor,
  postChat,
  startRoom,
  handleDisconnect,
  roomForSocket,
  getRoom,
  publicRoomState,
  registerProxyRequest,
  resolveProxyRequest,
} from "./rooms.js";

const app = express();
app.use(cors());
app.use(express.json());

// What Render's own health checks hit, and what an UptimeRobot-style
// monitor should be pointed at to keep a free-tier instance from ever
// spinning down from inactivity — see the README for why this matters.
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.status(200).send("STORM relay is running."));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

function broadcastRoomState(roomCode: string) {
  const room = getRoom(roomCode);
  if (!room) return;
  io.to(roomCode).emit("room:state", publicRoomState(room));
}

io.on("connection", (socket: Socket) => {
  socket.on("room:create", (payload: { displayName?: string }, ack?: (res: any) => void) => {
    const room = createRoom(socket.id, payload?.displayName ?? "Host");
    socket.join(room.code);
    ack?.({ ok: true, room: publicRoomState(room) });
  });

  socket.on("room:join", (payload: { code?: string; displayName?: string }, ack?: (res: any) => void) => {
    const result = joinRoom(payload?.code ?? "", socket.id, payload?.displayName ?? "Guest");
    if (!result.ok) return ack?.(result);
    socket.join(result.room.code);
    ack?.({ ok: true, room: publicRoomState(result.room) });
    broadcastRoomState(result.room.code);
  });

  socket.on("room:selectSeat", (payload: { seat?: number }, ack?: (res: any) => void) => {
    const result = selectSeat(socket.id, Number(payload?.seat));
    ack?.(result.ok ? { ok: true } : result);
    if (result.ok) broadcastRoomState(result.room.code);
  });

  socket.on("room:transferSupervisor", (payload: { toSocketId?: string }, ack?: (res: any) => void) => {
    const result = transferSupervisor(socket.id, payload?.toSocketId ?? "");
    ack?.(result.ok ? { ok: true } : result);
    if (result.ok) broadcastRoomState(result.room.code);
  });

  socket.on("room:chat", (payload: { text?: string }, ack?: (res: any) => void) => {
    const result = postChat(socket.id, payload?.text ?? "");
    if (!result.ok) return ack?.(result);
    ack?.({ ok: true });
    io.to(result.room.code).emit("room:chat", result.message);
  });

  // Only the Supervisor may start; whether the room ends up "solo" or
  // "multiplayer" is decided purely by how many players are present at
  // this moment (see rooms.ts's startRoom). From here on, the host's own
  // local STORM server is the live game backend — everyone else's
  // gameplay traffic gets proxied to it below.
  socket.on("room:start", (_payload: unknown, ack?: (res: any) => void) => {
    const result = startRoom(socket.id);
    if (!result.ok) return ack?.(result);
    ack?.({ ok: true });
    io.to(result.room.code).emit("room:started", { mode: result.room.mode });
    broadcastRoomState(result.room.code);
  });

  // --- Gameplay proxy (once a room is in_game) ---------------------------
  // A non-host client's STORM game client never talks to the host
  // directly — it can't, the host usually isn't reachable from the open
  // internet. Instead it sends its /api/* calls here, tagged with a
  // requestId, and this relay hands them to the host's own socket
  // connection. The host's browser makes the real call against its own
  // localhost STORM server (which it can always reach) and sends the
  // response back the same way. Every hop is an outbound connection to
  // this relay, so no port-forwarding or NAT traversal is needed anywhere.
  socket.on(
    "api:request",
    (payload: { requestId: string; method: string; path: string; body?: unknown }) => {
      const room = roomForSocket(socket.id);
      if (!room || room.status !== "in_game") return;
      const host = room.players.find((p) => p.isHost);
      if (!host) return;
      registerProxyRequest(room, payload.requestId, socket.id, () => {
        io.to(socket.id).emit("api:response", {
          requestId: payload.requestId,
          status: 504,
          body: { ok: false, error: "The host didn't respond in time." },
        });
      });
      io.to(host.socketId).emit("api:request", payload);
    }
  );

  // Sent by the HOST's client, answering a proxied request above.
  socket.on(
    "api:response",
    (payload: { requestId: string; status: number; body: unknown }) => {
      const room = roomForSocket(socket.id);
      if (!room) return;
      const requesterSocketId = resolveProxyRequest(room, payload.requestId);
      if (!requesterSocketId) return; // already timed out, or unknown id — drop it
      io.to(requesterSocketId).emit("api:response", payload);
    }
  );

  socket.on("disconnect", () => {
    const result = handleDisconnect(socket.id);
    if (!result || result.emptied) return;
    if (result.hostLeft) {
      io.to(result.room.code).emit("room:hostLeft");
      return;
    }
    broadcastRoomState(result.room.code);
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4100;
httpServer.listen(PORT, () => {
  console.log(`STORM relay listening on :${PORT}`);
});

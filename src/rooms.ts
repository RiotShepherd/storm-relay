// The relay's entire job: track who's in which room, broker a small lobby
// (seats, chat, host/Supervisor), and once a room's game starts, forward
// gameplay requests between the room's host and everyone else. It never
// runs any STORM game logic itself — the host's own local STORM server is
// still what actually simulates the game; this just moves messages so no
// player ever needs to be reachable from the internet themselves.

export const SEAT_COUNT = 6;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud
const MAX_CHAT_HISTORY = 200;
// If the host doesn't answer a proxied request within this long, the
// requester gets a timeout error back rather than hanging forever (e.g.
// the host's tab crashed without a clean disconnect).
const PROXY_TIMEOUT_MS = 15000;

export interface Player {
  socketId: string;
  displayName: string;
  seat: number | null;
  isHost: boolean;
  isSupervisor: boolean;
  joinedAt: number;
}

export interface ChatMessage {
  id: number;
  author: string;
  text: string;
  at: number;
}

export type RoomStatus = "lobby" | "in_game";
export type GameMode = "solo" | "multiplayer";

export interface Room {
  code: string;
  players: Player[];
  chat: ChatMessage[];
  status: RoomStatus;
  mode: GameMode | null;
  createdAt: number;
  nextChatId: number;
  // requestId -> the socketId that made the proxied /api call, so the
  // host's response can be routed back to the right requester. Cleared
  // once answered or timed out.
  pendingProxyRequests: Map<string, { requesterSocketId: string; timer: NodeJS.Timeout }>;
}

// Public shape sent to clients — strips the internal pending-request map,
// which is relay bookkeeping only.
export function publicRoomState(room: Room) {
  return {
    code: room.code,
    players: room.players.map((p) => ({
      socketId: p.socketId,
      displayName: p.displayName,
      seat: p.seat,
      isHost: p.isHost,
      isSupervisor: p.isSupervisor,
    })),
    status: room.status,
    mode: room.mode,
    seatCount: SEAT_COUNT,
  };
}

const rooms = new Map<string, Room>();
// socketId -> room code, so a disconnect handler can find where to clean
// up without scanning every room.
const socketRoom = new Map<string, string>();

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  // Astronomically unlikely with a 33^4 (~1.19M) code space at hobby-project
  // scale, but fall back to a longer code rather than loop forever.
  return `${Date.now().toString(36)}`.toUpperCase();
}

export function roomForSocket(socketId: string): Room | undefined {
  const code = socketRoom.get(socketId);
  return code ? rooms.get(code) : undefined;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

export function createRoom(hostSocketId: string, displayName: string): Room {
  const code = generateRoomCode();
  const host: Player = {
    socketId: hostSocketId,
    displayName: displayName.trim() || "Host",
    seat: null,
    isHost: true,
    isSupervisor: true,
    joinedAt: Date.now(),
  };
  const room: Room = {
    code,
    players: [host],
    chat: [],
    status: "lobby",
    mode: null,
    createdAt: Date.now(),
    nextChatId: 1,
    pendingProxyRequests: new Map(),
  };
  rooms.set(code, room);
  socketRoom.set(hostSocketId, code);
  return room;
}

export function joinRoom(
  code: string,
  socketId: string,
  displayName: string
): { ok: true; room: Room } | { ok: false; error: string } {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { ok: false, error: "No room with that code — check it and try again." };
  if (room.status !== "lobby") return { ok: false, error: "That game has already started." };
  if (room.players.some((p) => p.socketId === socketId)) return { ok: true, room };

  room.players.push({
    socketId,
    displayName: displayName.trim() || "Guest",
    seat: null,
    isHost: false,
    isSupervisor: false,
    joinedAt: Date.now(),
  });
  socketRoom.set(socketId, code);
  return { ok: true, room };
}

export function selectSeat(
  socketId: string,
  seat: number
): { ok: true; room: Room } | { ok: false; error: string } {
  const room = roomForSocket(socketId);
  if (!room) return { ok: false, error: "You're not in a room." };
  if (room.status !== "lobby") return { ok: false, error: "The game's already started." };
  if (!Number.isInteger(seat) || seat < 1 || seat > SEAT_COUNT) return { ok: false, error: "Invalid seat." };
  if (room.players.some((p) => p.seat === seat && p.socketId !== socketId)) {
    return { ok: false, error: "That seat's already taken." };
  }
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return { ok: false, error: "You're not in a room." };
  player.seat = seat;
  return { ok: true, room };
}

export function transferSupervisor(
  socketId: string,
  toSocketId: string
): { ok: true; room: Room } | { ok: false; error: string } {
  const room = roomForSocket(socketId);
  if (!room) return { ok: false, error: "You're not in a room." };
  const from = room.players.find((p) => p.socketId === socketId);
  if (!from?.isSupervisor) return { ok: false, error: "Only the current Supervisor can hand off the role." };
  const to = room.players.find((p) => p.socketId === toSocketId);
  if (!to) return { ok: false, error: "That player isn't in this room." };
  from.isSupervisor = false;
  to.isSupervisor = true;
  return { ok: true, room };
}

export function postChat(socketId: string, text: string): { ok: true; room: Room; message: ChatMessage } | { ok: false; error: string } {
  const room = roomForSocket(socketId);
  if (!room) return { ok: false, error: "You're not in a room." };
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return { ok: false, error: "You're not in a room." };
  const trimmed = text.trim().slice(0, 500);
  if (!trimmed) return { ok: false, error: "Empty message." };
  const message: ChatMessage = { id: room.nextChatId++, author: player.displayName, text: trimmed, at: Date.now() };
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT_HISTORY) room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);
  return { ok: true, room, message };
}

// First player in is host+Supervisor by default (see createRoom). Starting
// solo (nobody else joined) vs multiplayer is decided here, purely from
// how many players are present the moment the Supervisor hits Start — it
// isn't locked in any earlier than that.
export function startRoom(socketId: string): { ok: true; room: Room } | { ok: false; error: string } {
  const room = roomForSocket(socketId);
  if (!room) return { ok: false, error: "You're not in a room." };
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player?.isSupervisor) return { ok: false, error: "Only the Supervisor can start the game." };
  if (room.status !== "lobby") return { ok: false, error: "Already started." };
  room.status = "in_game";
  room.mode = room.players.length > 1 ? "multiplayer" : "solo";
  return { ok: true, room };
}

export function registerProxyRequest(room: Room, requestId: string, requesterSocketId: string, onTimeout: () => void) {
  const timer = setTimeout(() => {
    room.pendingProxyRequests.delete(requestId);
    onTimeout();
  }, PROXY_TIMEOUT_MS);
  room.pendingProxyRequests.set(requestId, { requesterSocketId, timer });
}

export function resolveProxyRequest(room: Room, requestId: string): string | undefined {
  const pending = room.pendingProxyRequests.get(requestId);
  if (!pending) return undefined;
  clearTimeout(pending.timer);
  room.pendingProxyRequests.delete(requestId);
  return pending.requesterSocketId;
}

// Removes a disconnected socket from whatever room it was in, reassigning
// host+Supervisor to the next-longest-connected remaining player if the
// leaver held either role. Returns what changed so the caller can decide
// what to broadcast (and whether the room should be torn down).
export function handleDisconnect(socketId: string): { room: Room; emptied: boolean; hostLeft: boolean } | undefined {
  const room = roomForSocket(socketId);
  if (!room) return undefined;
  socketRoom.delete(socketId);

  const leaving = room.players.find((p) => p.socketId === socketId);
  room.players = room.players.filter((p) => p.socketId !== socketId);

  // Fail every proxied request this socket was waiting on (it can no
  // longer receive the answer anyway) or that it — as host — was about to
  // service (nobody left to answer them).
  for (const [requestId, pending] of room.pendingProxyRequests) {
    if (pending.requesterSocketId === socketId) {
      clearTimeout(pending.timer);
      room.pendingProxyRequests.delete(requestId);
    }
  }

  const hostLeft = !!leaving?.isHost;

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return { room, emptied: true, hostLeft };
  }

  // The "host" is whoever's local STORM server is actually running the
  // shared game — that only means something while still in the lobby
  // (nothing's running yet, so handing the label to the next player is
  // harmless). Once a game is live, there's no real server to migrate to,
  // so the host leaving ends that session rather than quietly promoting a
  // new "host" with nothing behind it. Supervisor (an in-room role, not a
  // server) can still safely pass to the next player either way.
  if (room.status === "lobby" && leaving?.isHost) {
    const successor = [...room.players].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    successor.isHost = true;
  }
  if (leaving?.isSupervisor) {
    const successor = [...room.players].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    successor.isSupervisor = true;
  }

  return { room, emptied: false, hostLeft: hostLeft && room.status === "in_game" };
}

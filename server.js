const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const WORLD_SIZE = 3000;
const MAX_PLAYERS = 50;
const ROUND_SECONDS = 180;
const PLAYER_RADIUS = 18;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const WEAPONS = [
  { name: "ปืนพกมาตรฐาน", damage: 22, cooldown: 420, speed: 620, spread: 0.035, pellets: 1, color: "#ffe08a" },
  { name: "ปืนกลเบา", damage: 11, cooldown: 150, speed: 650, spread: 0.12, pellets: 1, color: "#8de3ff" },
  { name: "ปืนลูกซอง", damage: 10, cooldown: 780, speed: 530, spread: 0.38, pellets: 6, color: "#ffb36b" },
  { name: "ปืนไรเฟิล", damage: 32, cooldown: 850, speed: 980, spread: 0.012, pellets: 1, color: "#f7f7ff" },
  { name: "ปืนเลเซอร์", damage: 18, cooldown: 240, speed: 1050, spread: 0.025, pellets: 1, color: "#83ffcf" },
  { name: "ปืนระเบิด", damage: 38, cooldown: 1050, speed: 430, spread: 0.08, pellets: 1, color: "#ff806b", splash: 78 },
  { name: "ปืนพ่นดาว", damage: 15, cooldown: 330, speed: 580, spread: 0.2, pellets: 2, color: "#c6a5ff" },
  { name: "ปืนโฟม (เบา)", damage: 6, cooldown: 580, speed: 420, spread: 0.18, pellets: 1, color: "#d4f28a" },
  { name: "ปืนเก่าติดขัด", damage: 8, cooldown: 1150, speed: 390, spread: 0.3, pellets: 1, color: "#d6b49b" },
  { name: "ปืนลูกดอกอ่อน", damage: 5, cooldown: 700, speed: 480, spread: 0.22, pellets: 1, color: "#ff9bb3" },
  { name: "ปืนลมย้อน", damage: 9, cooldown: 900, speed: 450, spread: 0.58, pellets: 1, color: "#b8c2d8" }
];

const rooms = new Map();
const clients = new Map();

function randomPosition(minDistanceFromCenter = 0) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const x = Math.round(70 + Math.random() * (WORLD_SIZE - 140));
    const y = Math.round(70 + Math.random() * (WORLD_SIZE - 140));
    if (Math.hypot(x - WORLD_SIZE / 2, y - WORLD_SIZE / 2) >= minDistanceFromCenter) return { x, y };
  }
  return { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
}

function safeStartPosition() {
  const angle = Math.random() * Math.PI * 2;
  const minRadius = 520;
  const maxRadius = 1280;
  const distance = Math.sqrt(minRadius ** 2 + Math.random() * (maxRadius ** 2 - minRadius ** 2));
  return {
    x: WORLD_SIZE / 2 + Math.cos(angle) * distance,
    y: WORLD_SIZE / 2 + Math.sin(angle) * distance
  };
}

function createRoom() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (rooms.has(code));
  const room = {
    code,
    players: new Map(),
    bullets: [],
    pickups: [],
    startedAt: null,
    playerCountAtStart: 0,
    eliminatedCount: 0,
    gameOver: false,
    winnerId: null,
    lastTick: Date.now()
  };
  for (let i = 0; i < 68; i += 1) {
    const position = randomPosition();
    room.pickups.push({ x: position.x, y: position.y, weapon: Math.floor(Math.random() * WEAPONS.length) });
  }
  rooms.set(code, room);
  return room;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function notify(room, message) {
  const payload = JSON.stringify(message);
  for (const player of room.players.values()) {
    if (player.socket.readyState === WebSocket.OPEN && player.socket.bufferedAmount < 65536) {
      player.socket.send(payload);
    }
  }
}

function leaveRoom(socket) {
  const client = clients.get(socket);
  if (!client) return;
  const room = rooms.get(client.roomCode);
  if (room) {
    room.players.delete(client.id);
    if (room.players.size === 0) rooms.delete(room.code);
    else notify(room, { type: "notice", text: `${client.name} ออกจากห้อง` });
  }
  clients.delete(socket);
}

function joinRoom(socket, code, name) {
  const room = rooms.get(String(code || "").trim().toUpperCase());
  if (!room) {
    send(socket, { type: "error", message: "ไม่พบห้องนี้ ลองตรวจสอบลิงก์หรือรหัสห้องอีกครั้ง" });
    return;
  }
  if (room.players.size >= MAX_PLAYERS) {
    send(socket, { type: "error", message: "ห้องนี้มีผู้เล่นครบ 50 คนแล้ว" });
    return;
  }
  if (room.startedAt !== null || room.gameOver) {
    send(socket, { type: "error", message: "เกมเริ่มไปแล้ว กรุณาสร้างห้องใหม่" });
    return;
  }
  const id = randomUUID();
  const position = safeStartPosition();
  const player = {
    id,
    name: String(name || "ผู้เล่น").trim().slice(0, 20) || "ผู้เล่น",
    x: position.x,
    y: position.y,
    angle: 0,
    weapon: 0,
    lives: 5,
    alive: true,
    placement: null,
    respawnAt: 0,
    nextShotAt: 0,
    nextZoneDamageAt: 0,
    input: { up: false, down: false, left: false, right: false, firing: false }
  };
  player.socket = socket;
  room.players.set(id, player);
  clients.set(socket, { id, roomCode: room.code, name: player.name });
  send(socket, {
    type: "joined",
    id,
    room: room.code,
    worldSize: WORLD_SIZE,
    maxPlayers: MAX_PLAYERS,
    weapons: WEAPONS.map(({ name: weaponName }, index) => ({ id: index, name: weaponName }))
  });
  notify(room, { type: "notice", text: `${player.name} เข้าร่วมห้องแล้ว` });
}

function zoneFor(room, now) {
  const elapsed = room.startedAt === null ? 0 : (now - room.startedAt) / 1000;
  const progress = Math.min(1, elapsed / ROUND_SECONDS);
  return { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, radius: 1370 - progress * 1190, remaining: Math.max(0, ROUND_SECONDS - elapsed) };
}

function loseLife(room, player, now) {
  if (!player.alive) return;
  player.lives -= 1;
  player.alive = false;
  player.input.firing = false;
  if (player.lives > 0) {
    player.respawnAt = now + 2500;
  } else {
    player.lives = 0;
    player.respawnAt = 0;
    player.placement = Math.max(1, room.playerCountAtStart - room.eliminatedCount);
    room.eliminatedCount += 1;
  }
}

function respawnPosition(zone) {
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.sqrt(Math.random()) * Math.max(0, zone.radius - 80);
  return {
    x: zone.x + Math.cos(angle) * distance,
    y: zone.y + Math.sin(angle) * distance
  };
}

function shoot(room, player, now) {
  const weapon = WEAPONS[player.weapon] || WEAPONS[0];
  if (!player.alive || !player.input.firing || now < player.nextShotAt) return;
  player.nextShotAt = now + weapon.cooldown;
  for (let i = 0; i < weapon.pellets; i += 1) {
    const angle = player.angle + (Math.random() - 0.5) * weapon.spread;
    room.bullets.push({
      id: randomUUID(),
      owner: player.id,
      x: player.x + Math.cos(angle) * (PLAYER_RADIUS + 7),
      y: player.y + Math.sin(angle) * (PLAYER_RADIUS + 7),
      vx: Math.cos(angle) * weapon.speed,
      vy: Math.sin(angle) * weapon.speed,
      damage: weapon.damage,
      life: 1.8,
      splash: weapon.splash || 0,
      color: weapon.color
    });
  }
}

function tickRoom(room, now) {
  const delta = Math.min(0.06, Math.max(0, (now - room.lastTick) / 1000));
  room.lastTick = now;
  if (room.startedAt === null || room.gameOver) return;
  const zone = zoneFor(room, now);
  for (const player of room.players.values()) {
    if (!player.alive) {
      if (player.lives > 0 && now >= player.respawnAt) {
        const position = respawnPosition(zone);
        player.x = position.x;
        player.y = position.y;
        player.alive = true;
        player.weapon = 0;
        player.respawnAt = 0;
        player.nextZoneDamageAt = now + 1000;
        send(player.socket, { type: "notice", text: `เกิดใหม่แล้ว เหลือ ${player.lives} ชีวิต` });
      }
      continue;
    }

    const dx = Number(player.input.right) - Number(player.input.left);
    const dy = Number(player.input.down) - Number(player.input.up);
    const length = Math.hypot(dx, dy) || 1;
    const speed = 250;
    player.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_SIZE - PLAYER_RADIUS, player.x + (dx / length) * speed * delta));
    player.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_SIZE - PLAYER_RADIUS, player.y + (dy / length) * speed * delta));
    if (Math.hypot(player.x - zone.x, player.y - zone.y) > zone.radius && now >= player.nextZoneDamageAt) {
      loseLife(room, player, now);
      player.nextZoneDamageAt = now + 1000;
      if (player.lives > 0) {
        send(player.socket, { type: "notice", text: `อยู่นอกวงปลอดภัย! เสีย 1 ชีวิต เหลือ ${player.lives}` });
      }
    }
    if (player.alive) shoot(room, player, now);

    const pickupIndex = room.pickups.findIndex((pickup) => Math.hypot(player.x - pickup.x, player.y - pickup.y) < PLAYER_RADIUS + 16);
    if (pickupIndex !== -1) {
      const [pickup] = room.pickups.splice(pickupIndex, 1);
      player.weapon = pickup.weapon;
      send(player.socket, { type: "notice", text: `เก็บ ${WEAPONS[pickup.weapon].name} แล้ว` });
      if (room.pickups.length < 24) {
        const position = randomPosition();
        room.pickups.push({ x: position.x, y: position.y, weapon: Math.floor(Math.random() * WEAPONS.length) });
      }
    }
  }

  for (const bullet of room.bullets) {
    bullet.x += bullet.vx * delta;
    bullet.y += bullet.vy * delta;
    bullet.life -= delta;
    for (const target of room.players.values()) {
      if (!target.alive || target.id === bullet.owner) continue;
      if (Math.hypot(target.x - bullet.x, target.y - bullet.y) > PLAYER_RADIUS + 5) continue;
      if (bullet.splash) {
        for (const nearby of room.players.values()) {
          if (nearby.alive && nearby.id !== bullet.owner && Math.hypot(nearby.x - bullet.x, nearby.y - bullet.y) <= bullet.splash) {
            loseLife(room, nearby, now);
          }
        }
      } else {
        loseLife(room, target, now);
      }
      bullet.life = 0;
      break;
    }
  }
  room.bullets = room.bullets.filter((bullet) => bullet.life > 0 && bullet.x >= 0 && bullet.y >= 0 && bullet.x <= WORLD_SIZE && bullet.y <= WORLD_SIZE);

  const activePlayers = [...room.players.values()].filter((player) => player.lives > 0);
  if (room.playerCountAtStart > 1 && activePlayers.length <= 1) {
    room.gameOver = true;
    room.winnerId = activePlayers[0]?.id || null;
    finalizePlacements(room);
    notify(room, { type: "gameOver", winnerId: room.winnerId });
  } else if (zone.remaining <= 0) {
    room.gameOver = true;
    activePlayers.sort((a, b) => b.lives - a.lives || Number(b.alive) - Number(a.alive));
    room.winnerId = activePlayers[0]?.id || null;
    finalizePlacements(room, activePlayers);
    notify(room, { type: "gameOver", winnerId: room.winnerId });
  }
}

function finalizePlacements(room, survivors = [...room.players.values()].filter((player) => player.lives > 0)) {
  survivors.sort((a, b) => b.lives - a.lives || Number(b.alive) - Number(a.alive));
  survivors.forEach((player, index) => {
    player.placement = index + 1;
  });
}

function snapshot(room, now) {
  const zone = zoneFor(room, now);
  return {
    type: "state",
    started: room.startedAt !== null,
    gameOver: room.gameOver,
    winnerId: room.winnerId,
    worldSize: WORLD_SIZE,
    zone: {
      x: zone.x,
      y: zone.y,
      radius: Math.round(zone.radius * 10) / 10,
      remaining: Math.round(zone.remaining * 10) / 10
    },
    players: [...room.players.values()].map(({ id, name, x, y, angle, weapon, lives, alive, respawnAt, placement }) => ({
      id,
      name,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      angle: Math.round(angle * 1000) / 1000,
      weapon,
      lives,
      alive,
      placement,
      respawnIn: alive ? 0 : Math.max(0, respawnAt - now)
    })),
    pickups: room.pickups,
    bullets: room.bullets.map(({ x, y, vx, vy, color }) => ({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      vx: Math.round(vx),
      vy: Math.round(vy),
      color
    }))
  };
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  const requestedFile = pathname === "/" ? "index.html" : path.basename(pathname);
  const filePath = path.join(PUBLIC_DIR, requestedFile);
  if (!Object.hasOwn(MIME_TYPES, path.extname(filePath))) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)], "Cache-Control": "no-store" });
    response.end(content);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "error", message: "ข้อมูลที่ส่งมาไม่ถูกต้อง" });
      return;
    }
    if (!message || typeof message.type !== "string") {
      send(socket, { type: "error", message: "คำสั่งไม่ถูกต้อง" });
      return;
    }
    if (message.type === "create") {
      if (clients.has(socket)) leaveRoom(socket);
      const room = createRoom();
      joinRoom(socket, room.code, message.name);
      return;
    }
    if (message.type === "join") {
      if (clients.has(socket)) leaveRoom(socket);
      joinRoom(socket, message.room, message.name);
      return;
    }
    const client = clients.get(socket);
    if (!client) return;
    const room = rooms.get(client.roomCode);
    const player = room?.players.get(client.id);
    if (!room || !player) return;
    if (message.type === "start") {
      if (room.startedAt === null && !room.gameOver) {
        room.startedAt = Date.now();
        room.playerCountAtStart = room.players.size;
        notify(room, { type: "notice", text: "เริ่มเกมแล้ว! เก็บอาวุธและระวังวงบีบ" });
      }
    } else if (message.type === "input" && !room.gameOver) {
      const input = message.input || {};
      player.input = {
        up: Boolean(input.up),
        down: Boolean(input.down),
        left: Boolean(input.left),
        right: Boolean(input.right),
        firing: Boolean(input.firing)
      };
      if (Number.isFinite(message.angle)) player.angle = Math.atan2(Math.sin(message.angle), Math.cos(message.angle));
      if (room.startedAt !== null && player.alive && player.input.firing) {
        shoot(room, player, Date.now());
      }
    }
  });
  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

let lastLobbyBroadcast = 0;
setInterval(() => {
  const now = Date.now();
  const sendLobby = now - lastLobbyBroadcast >= 150;
  if (sendLobby) lastLobbyBroadcast = now;
  for (const room of rooms.values()) {
    tickRoom(room, now);
    if (room.startedAt !== null) notify(room, snapshot(room, now));
    else if (sendLobby) notify(room, {
      type: "lobby",
      room: room.code,
      players: [...room.players.values()].map(({ id, name }) => ({ id, name })),
      maxPlayers: MAX_PLAYERS
    });
  }
}, 33);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Classroom Battle is running on port ${PORT}`);
});

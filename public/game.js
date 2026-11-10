const lobby = document.querySelector("#lobby");
const game = document.querySelector("#game");
const joinForm = document.querySelector("#join-form");
const nameInput = document.querySelector("#player-name");
const roomInput = document.querySelector("#room-code");
const lobbyError = document.querySelector("#lobby-error");
const createButton = document.querySelector("#create-button");
const joinButton = document.querySelector("#join-button");
const arena = document.querySelector("#arena-canvas");
const minimap = document.querySelector("#minimap");
const context = arena.getContext("2d");
const mapContext = minimap.getContext("2d");
const ARMOR_PALETTES = [
  { armor: "#667244", armorLight: "#94a266", trim: "#d0b578" },
  { armor: "#476976", armorLight: "#7195a0", trim: "#c5a873" },
  { armor: "#926345", armorLight: "#bb8b62", trim: "#ded0ad" },
  { armor: "#6d6082", armorLight: "#9383a9", trim: "#d3bf8e" },
  { armor: "#8a4c49", armorLight: "#b16b60", trim: "#d7c391" },
  { armor: "#48705e", armorLight: "#6e977e", trim: "#c9b57f" }
];

let socket;
let myId = null;
let roomCode = "";
let state = null;
let weapons = [];
let camera = { x: 0, y: 0 };
let mouse = { x: 0, y: 0 };
let keys = new Set();
let firing = false;
let toastTimeout;
let groundPattern;
let mapFeatures = [];
let soldierSprites = [];
let weaponSprites = [];
let rankingSignature = "";
let renderPlayers = new Map();
let lastFrameTime = performance.now();
let localAngle = 0;

const params = new URLSearchParams(location.search);
if (params.has("room")) roomInput.value = params.get("room").toUpperCase();

function openConnection(action, name, code) {
  lobbyError.textContent = "";
  joinButton.disabled = true;
  createButton.disabled = true;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: action, name, room: code }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "error") {
      lobbyError.textContent = message.message;
      joinButton.disabled = false;
      createButton.disabled = false;
      socket.close();
    } else if (message.type === "joined") {
      myId = message.id;
      roomCode = message.room;
      weapons = message.weapons;
      initializeGraphics(roomCode, message.worldSize);
      history.replaceState(null, "", `?room=${encodeURIComponent(roomCode)}`);
      document.querySelector("#room-label").textContent = roomCode;
      document.querySelector("#overlay-room").textContent = roomCode;
      lobby.classList.add("hidden");
      game.classList.remove("hidden");
      resizeCanvas();
      requestAnimationFrame(draw);
    } else if (message.type === "lobby") {
      state = message;
      updateLobby(message);
    } else if (message.type === "state") {
      if (state?.players) {
        for (const p of message.players) {
          const prev = renderPlayers.get(p.id);
          if (!prev || !p.alive || Math.hypot(p.x - prev.x, p.y - prev.y) > 140) {
            renderPlayers.set(p.id, { x: p.x, y: p.y, angle: p.angle });
          }
        }
      }
      state = message;
      updateHud(message);
    } else if (message.type === "notice") {
      showToast(message.text);
    } else if (message.type === "gameOver") {
      showResult(message.winnerId);
    }
  });
  socket.addEventListener("close", () => {
    if (!game.classList.contains("hidden")) showToast("การเชื่อมต่อขาดหาย กรุณาโหลดหน้าเว็บใหม่");
    joinButton.disabled = false;
    createButton.disabled = false;
  });
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const code = roomInput.value.trim();
  if (!name) {
    lobbyError.textContent = "กรุณาใส่ชื่อก่อนเข้าห้อง";
    return;
  }
  if (!code) {
    lobbyError.textContent = "ใส่รหัสห้อง หรือเลือกสร้างห้องใหม่";
    return;
  }
  openConnection("join", name, code);
});

createButton.addEventListener("click", () => {
  if (!nameInput.value.trim()) {
    lobbyError.textContent = "กรุณาใส่ชื่อก่อนสร้างห้อง";
    nameInput.focus();
    return;
  }
  openConnection("create", nameInput.value.trim());
});

document.querySelector("#copy-link").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/?room=${encodeURIComponent(roomCode)}`);
    event.currentTarget.textContent = "คัดลอกแล้ว!";
    setTimeout(() => { event.currentTarget.textContent = "คัดลอกลิงก์"; }, 1600);
  } catch {
    showToast(`ลิงก์ห้อง: ${location.origin}/?room=${roomCode}`);
  }
});

document.querySelector("#start-button").addEventListener("click", () => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "start" }));
});

document.querySelector("#back-button").addEventListener("click", () => {
  socket?.close();
  location.href = location.pathname;
});

function updateLobby(lobbyState) {
  document.querySelector("#players-count").textContent = `ผู้เล่น ${lobbyState.players.length} / ${lobbyState.maxPlayers}`;
  document.querySelector("#waiting-text").textContent = `มีผู้เล่น ${lobbyState.players.length} / ${lobbyState.maxPlayers} คน`;
  updateLeaderboard({
    players: lobbyState.players.map((player) => ({ ...player, lives: 5, alive: true })),
    gameOver: false
  });
  const list = document.querySelector("#player-list");
  list.replaceChildren(...lobbyState.players.map((player) => {
    const chip = document.createElement("span");
    chip.className = "player-chip";
    chip.textContent = player.name;
    return chip;
  }));
}

function updateHud(gameState) {
  const me = gameState.players.find((player) => player.id === myId);
  document.querySelector("#players-count").textContent = `ผู้เล่น ${gameState.players.filter((player) => player.lives > 0).length} / 50`;
  updateLeaderboard(gameState);
  document.querySelector("#countdown").textContent = `${Math.floor(gameState.zone.remaining / 60)}:${String(Math.floor(gameState.zone.remaining % 60)).padStart(2, "0")}`;
  if (me) {
    document.querySelector("#lives").textContent = `${"♥ ".repeat(me.lives)}${"♡ ".repeat(5 - me.lives)}`.trim();
    document.querySelector("#weapon-label").textContent = weapons[me.weapon]?.name || "ปืนพกมาตรฐาน";
    if (!me.alive && me.lives > 0) {
      document.querySelector("#countdown").textContent = `เกิดใหม่ ${Math.ceil(me.respawnIn / 1000)}s`;
    }
  }
  if (gameState.started) document.querySelector("#lobby-overlay").classList.add("hidden");
  if (gameState.gameOver) showResult(gameState.winnerId);
}

function updateLeaderboard(gameState) {
  const players = [...gameState.players];
  if (gameState.gameOver) {
    players.sort((a, b) => (a.placement ?? Infinity) - (b.placement ?? Infinity));
  } else {
    players.sort((a, b) => {
      const aliveOrder = Number(b.alive) - Number(a.alive);
      if (aliveOrder) return aliveOrder;
      const lifeOrder = Number(b.lives > 0) - Number(a.lives > 0);
      if (lifeOrder) return lifeOrder;
      if (a.lives > 0 && b.lives > 0) return b.lives - a.lives;
      return (a.placement ?? Infinity) - (b.placement ?? Infinity);
    });
  }
  const signature = `${gameState.gameOver}:${players.map((player) => `${player.id}:${player.name}:${player.lives}:${player.alive}:${player.placement}`).join("|")}`;
  if (signature === rankingSignature) return;
  rankingSignature = signature;
  document.querySelector("#rank-total").textContent = `${players.length} / 50`;
  const list = document.querySelector("#ranking-list");
  const rows = players.map((player, index) => {
    const row = document.createElement("div");
    const eliminated = player.lives <= 0;
    row.className = `ranking-row${player.id === myId ? " is-self" : ""}${eliminated ? " is-out" : ""}`;
    const rank = document.createElement("span");
    rank.className = "rank-number";
    rank.textContent = String(player.placement ?? index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "ranking-name";
    name.textContent = player.id === myId ? `${player.name} (คุณ)` : player.name;
    const status = document.createElement("span");
    status.className = "rank-status";
    status.textContent = player.alive ? `♥ ${player.lives}` : player.lives > 0 ? "เกิดใหม่" : "ออกแล้ว";
    row.append(rank, name, status);
    return row;
  });
  list.replaceChildren(...rows);
}

function showResult(winnerId) {
  const winner = state?.players?.find((player) => player.id === winnerId);
  document.querySelector("#result-title").textContent = winner ? (winner.id === myId ? "คุณชนะ!" : `${winner.name} ชนะ!`) : "ไม่มีผู้ชนะ";
  document.querySelector("#result-message").textContent = winner ? `เหลือ ${winner.lives} ชีวิตในสนามประลอง` : "ทุกคนหมดชีวิตแล้ว ลองเล่นกันอีกครั้ง";
  document.querySelector("#result-overlay").classList.remove("hidden");
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 2300);
}

function resizeCanvas() {
  const rect = arena.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  arena.width = Math.round(rect.width * ratio);
  arena.height = Math.round(rect.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const mapRect = minimap.getBoundingClientRect();
  minimap.width = Math.round(mapRect.width * ratio);
  minimap.height = Math.round(mapRect.height * ratio);
  mapContext.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function computeLocalAngle() {
  const rect = arena.getBoundingClientRect();
  const renderedMe = renderPlayers.get(myId);
  const me = renderedMe || state?.players?.find((player) => player.id === myId);
  const screenX = me ? me.x - camera.x : rect.width / 2;
  const screenY = me ? me.y - camera.y : rect.height / 2;
  localAngle = Math.atan2(mouse.y - screenY, mouse.x - screenX);
  return localAngle;
}

function sendInputNow() {
  if (socket?.readyState !== WebSocket.OPEN || !myId || !state?.started) return;
  const angle = computeLocalAngle();
  socket.send(JSON.stringify({
    type: "input",
    input: {
      up: keys.has("w") || keys.has("arrowup"),
      down: keys.has("s") || keys.has("arrowdown"),
      left: keys.has("a") || keys.has("arrowleft"),
      right: keys.has("d") || keys.has("arrowright"),
      firing
    },
    angle: Math.round(angle * 1000) / 1000
  }));
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  const key = event.key.toLowerCase();
  if (!keys.has(key)) {
    keys.add(key);
    sendInputNow();
  }
});
window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (keys.delete(key)) sendInputNow();
});
window.addEventListener("blur", () => {
  keys.clear();
  firing = false;
  sendInputNow();
});
arena.addEventListener("mousemove", (event) => {
  const rect = arena.getBoundingClientRect();
  mouse.x = event.clientX - rect.left;
  mouse.y = event.clientY - rect.top;
  computeLocalAngle();
});
arena.addEventListener("mousedown", () => {
  firing = true;
  sendInputNow();
});
window.addEventListener("mouseup", () => {
  if (firing) {
    firing = false;
    sendInputNow();
  }
});
arena.addEventListener("contextmenu", (event) => event.preventDefault());

setInterval(sendInputNow, 33);

function stepSmoothState(dt) {
  if (!state?.started) return;
  const worldSize = state.worldSize || 3000;
  const activeIds = new Set();
  for (const player of state.players) {
    activeIds.add(player.id);
    let rendered = renderPlayers.get(player.id);
    if (!rendered) {
      rendered = { x: player.x, y: player.y, angle: player.angle };
      renderPlayers.set(player.id, rendered);
    }
    if (!player.alive) {
      rendered.x = player.x;
      rendered.y = player.y;
      rendered.angle = player.angle;
      continue;
    }
    if (player.id === myId) {
      const dx = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
      const dy = (keys.has("s") || keys.has("arrowdown") ? 1 : 0) - (keys.has("w") || keys.has("arrowup") ? 1 : 0);
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        rendered.x = Math.max(18, Math.min(worldSize - 18, rendered.x + (dx / len) * 250 * dt));
        rendered.y = Math.max(18, Math.min(worldSize - 18, rendered.y + (dy / len) * 250 * dt));
      }
      const blend = Math.min(1, dt * 10);
      rendered.x += (player.x - rendered.x) * blend;
      rendered.y += (player.y - rendered.y) * blend;
      rendered.angle = computeLocalAngle();
    } else {
      const blend = Math.min(1, dt * 16);
      rendered.x += (player.x - rendered.x) * blend;
      rendered.y += (player.y - rendered.y) * blend;
      const diff = Math.atan2(Math.sin(player.angle - rendered.angle), Math.cos(player.angle - rendered.angle));
      rendered.angle += diff * Math.min(1, dt * 20);
    }
  }
  for (const id of renderPlayers.keys()) {
    if (!activeIds.has(id)) renderPlayers.delete(id);
  }
  for (const bullet of state.bullets) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
  }
}

function draw(now = performance.now()) {
  if (game.classList.contains("hidden")) return;
  const dt = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  const width = arena.clientWidth;
  const height = arena.clientHeight;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#222922";
  context.fillRect(0, 0, width, height);
  if (!state?.started) {
    requestAnimationFrame(draw);
    return;
  }
  stepSmoothState(dt);
  const me = state.players.find((player) => player.id === myId);
  const renderedMe = renderPlayers.get(myId) || me;
  if (renderedMe) {
    camera.x = Math.max(0, Math.min(state.worldSize - width, renderedMe.x - width / 2));
    camera.y = Math.max(0, Math.min(state.worldSize - height, renderedMe.y - height / 2));
  }
  context.save();
  context.translate(-camera.x, -camera.y);
  drawGround(state.worldSize);
  drawRoads(state.worldSize);
  drawMapFeatures(width, height);
  drawZone(state.zone);
  for (const pickup of state.pickups) drawPickup(pickup);
  for (const bullet of state.bullets) drawBullet(bullet);
  for (const player of state.players) drawPlayer(player);
  context.restore();
  drawVignette(width, height);
  drawPlayerGlow(me && renderedMe ? { ...me, x: renderedMe.x, y: renderedMe.y } : me, width, height);
  drawMinimap();
  requestAnimationFrame(draw);
}

function initializeGraphics(seed, worldSize) {
  groundPattern = createGroundPattern();
  soldierSprites = ARMOR_PALETTES.map(createSoldierSprite);
  weaponSprites = weapons.map((weapon, index) => createWeaponSprite(index, weapon.name));

  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  const random = () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
  mapFeatures = Array.from({ length: 170 }, () => ({
    x: 45 + random() * (worldSize - 90),
    y: 45 + random() * (worldSize - 90),
    size: 8 + random() * 25,
    rotation: random() * Math.PI * 2,
    type: random()
  }));
}

function createGroundPattern() {
  const tile = document.createElement("canvas");
  tile.width = 224;
  tile.height = 224;
  const tileContext = tile.getContext("2d");
  tileContext.fillStyle = "#34372f";
  tileContext.fillRect(0, 0, tile.width, tile.height);
  for (let i = 0; i < 10; i += 1) {
    const x = Math.random() * tile.width;
    const y = Math.random() * tile.height;
    const radius = 20 + Math.random() * 48;
    const patch = tileContext.createRadialGradient(x, y, 0, x, y, radius);
    patch.addColorStop(0, i % 2 ? "#46423644" : "#74805c22");
    patch.addColorStop(1, "#34372f00");
    tileContext.fillStyle = patch;
    tileContext.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  for (let i = 0; i < 420; i += 1) {
    const x = Math.random() * tile.width;
    const y = Math.random() * tile.height;
    const shade = Math.random() > 0.5 ? "#171d1a26" : "#aca17620";
    tileContext.fillStyle = shade;
    tileContext.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  for (let i = 0; i < 28; i += 1) {
    const x = Math.random() * tile.width;
    const y = Math.random() * tile.height;
    tileContext.strokeStyle = "#a18f6330";
    tileContext.lineWidth = 1;
    tileContext.beginPath();
    tileContext.moveTo(x, y);
    tileContext.lineTo(x + 2 + Math.random() * 5, y + 1 + Math.random() * 4);
    tileContext.stroke();
  }
  return context.createPattern(tile, "repeat");
}

function createSoldierSprite(palette) {
  const sprite = document.createElement("canvas");
  sprite.width = 64;
  sprite.height = 64;
  const image = sprite.getContext("2d");
  image.fillStyle = "#080b0b80";
  image.beginPath();
  image.ellipse(32, 39, 19, 9, 0, 0, Math.PI * 2);
  image.fill();

  image.fillStyle = "#292b24";
  image.beginPath();
  image.roundRect(16, 25, 10, 15, 3);
  image.fill();
  image.fillStyle = "#181c1b";
  image.beginPath();
  image.roundRect(17, 35, 10, 5, 2);
  image.fill();
  image.fillStyle = "#292b24";
  image.beginPath();
  image.roundRect(32, 35, 10, 6, 2);
  image.fill();

  const armor = image.createLinearGradient(22, 23, 28, 43);
  armor.addColorStop(0, palette.armorLight);
  armor.addColorStop(0.42, palette.armor);
  armor.addColorStop(1, "#30352c");
  image.fillStyle = armor;
  image.beginPath();
  image.roundRect(21, 23, 22, 19, 7);
  image.fill();
  image.strokeStyle = "#171b19";
  image.lineWidth = 2;
  image.stroke();

  image.fillStyle = "#343a31";
  image.beginPath();
  image.ellipse(32, 32, 7, 11, 0, 0, Math.PI * 2);
  image.fill();
  image.fillStyle = palette.trim;
  image.globalAlpha = 0.8;
  image.fillRect(31, 25, 3, 14);
  image.globalAlpha = 1;

  image.fillStyle = "#222720";
  image.beginPath();
  image.roundRect(13, 26, 9, 13, 3);
  image.fill();
  image.strokeStyle = "#111514";
  image.lineWidth = 2;
  image.stroke();
  image.fillStyle = palette.armorLight;
  image.beginPath();
  image.roundRect(16, 27, 4, 8, 2);
  image.fill();

  image.fillStyle = "#30362c";
  image.beginPath();
  image.arc(39, 31, 7, 0, Math.PI * 2);
  image.fill();
  image.fillStyle = palette.armorLight;
  image.beginPath();
  image.arc(38, 29, 6, Math.PI, Math.PI * 1.94);
  image.lineWidth = 2;
  image.strokeStyle = palette.armorLight;
  image.stroke();
  image.beginPath();
  image.roundRect(41, 30, 5, 4, 2);
  image.fill();
  image.fillStyle = "#c4b38b";
  image.fillRect(42, 30, 3, 2);
  return sprite;
}

function createWeaponSprite(index) {
  const sprite = document.createElement("canvas");
  sprite.width = 64;
  sprite.height = 64;
  const image = sprite.getContext("2d");
  const lengths = [20, 32, 35, 38, 36, 34, 30, 27, 31, 26, 29];
  const length = lengths[index] || 30;
  const start = 31;
  const end = Math.min(62, start + length);
  const bodyY = index === 2 || index === 5 ? 28 : 30;
  const bodyHeight = index === 5 ? 9 : index === 2 ? 7 : 6;

  image.lineCap = "round";
  image.strokeStyle = "#111513";
  image.lineWidth = bodyHeight + 3;
  image.beginPath();
  image.moveTo(start, bodyY + bodyHeight / 2);
  image.lineTo(end, bodyY + bodyHeight / 2);
  image.stroke();
  image.strokeStyle = index === 3 ? "#77858a" : "#59615d";
  image.lineWidth = bodyHeight;
  image.beginPath();
  image.moveTo(start + 2, bodyY + bodyHeight / 2);
  image.lineTo(end - 2, bodyY + bodyHeight / 2);
  image.stroke();
  image.strokeStyle = "#adb2a8";
  image.lineWidth = 1;
  image.beginPath();
  image.moveTo(start + 5, bodyY + 1);
  image.lineTo(end - 5, bodyY + 1);
  image.stroke();

  image.fillStyle = "#272d2a";
  image.beginPath();
  image.roundRect(start + 5, bodyY - 5, Math.max(8, length * 0.4), bodyHeight + 5, 2);
  image.fill();
  image.fillStyle = "#171b19";
  image.beginPath();
  image.moveTo(start + 12, bodyY + bodyHeight - 1);
  image.lineTo(start + 19, bodyY + bodyHeight);
  image.lineTo(start + 16, bodyY + bodyHeight + 8);
  image.lineTo(start + 11, bodyY + bodyHeight + 6);
  image.closePath();
  image.fill();
  if (index === 0 || index === 9) {
    image.fillStyle = "#292e2a";
    image.fillRect(start + 13, bodyY - 3, 3, bodyHeight + 1);
  }
  if (index === 2 || index === 5) {
    image.strokeStyle = "#98927c";
    image.lineWidth = 2;
    image.beginPath();
    image.moveTo(start + 18, bodyY + bodyHeight);
    image.lineTo(start + 27, bodyY + bodyHeight + 4);
    image.stroke();
  }
  if (index === 4) {
    image.fillStyle = "#67dcc0";
    image.fillRect(end - 7, bodyY + 1, 4, 2);
  }
  image.fillStyle = "#161a19";
  image.fillRect(end - 3, bodyY - 1, 4, bodyHeight + 2);
  return sprite;
}

function drawGround(worldSize) {
  context.fillStyle = groundPattern || "#34372f";
  context.fillRect(0, 0, worldSize, worldSize);
}

function drawRoads(worldSize) {
  const roadX = Math.round(worldSize * 0.35);
  const roadY = Math.round(worldSize * 0.66);
  context.lineCap = "butt";
  context.strokeStyle = "#211f1a";
  context.lineWidth = 138;
  context.beginPath();
  context.moveTo(roadX, 0);
  context.lineTo(roadX, worldSize);
  context.moveTo(0, roadY);
  context.lineTo(worldSize, roadY);
  context.stroke();
  context.strokeStyle = "#48443a";
  context.lineWidth = 126;
  context.stroke();
  context.strokeStyle = "#837354";
  context.lineWidth = 2;
  context.setLineDash([25, 24]);
  context.beginPath();
  context.moveTo(roadX, 0);
  context.lineTo(roadX, worldSize);
  context.moveTo(0, roadY);
  context.lineTo(worldSize, roadY);
  context.stroke();
  context.setLineDash([]);
}

function drawMapFeatures(width, height) {
  for (const feature of mapFeatures) {
    if (feature.x < camera.x - 50 || feature.x > camera.x + width + 50 || feature.y < camera.y - 50 || feature.y > camera.y + height + 50) continue;
    context.save();
    context.translate(feature.x, feature.y);
    context.rotate(feature.rotation);
    if (feature.type < 0.28) {
      context.fillStyle = "#191d1b70";
      context.beginPath();
      context.ellipse(3, 4, feature.size * 1.15, feature.size * 0.68, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#252923";
      context.beginPath();
      context.ellipse(0, 0, feature.size, feature.size * 0.57, 0, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "#525245";
      context.lineWidth = 2;
      context.stroke();
      context.strokeStyle = "#181b19";
      context.lineWidth = 3;
      context.beginPath();
      context.ellipse(0, 0, feature.size * 0.55, feature.size * 0.3, 0, 0, Math.PI * 2);
      context.stroke();
    } else if (feature.type < 0.59) {
      context.fillStyle = "#161a18a0";
      context.beginPath();
      context.ellipse(3, 5, feature.size * 0.83, feature.size * 0.65, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#53554b";
      context.beginPath();
      context.moveTo(-feature.size, feature.size * 0.25);
      context.lineTo(-feature.size * 0.7, -feature.size * 0.48);
      context.lineTo(-feature.size * 0.1, -feature.size * 0.82);
      context.lineTo(feature.size * 0.7, -feature.size * 0.55);
      context.lineTo(feature.size, feature.size * 0.32);
      context.lineTo(feature.size * 0.15, feature.size * 0.73);
      context.closePath();
      context.fill();
      context.strokeStyle = "#858170";
      context.lineWidth = 1;
      context.stroke();
      context.strokeStyle = "#292d28";
      context.beginPath();
      context.moveTo(-feature.size * 0.55, 0);
      context.lineTo(feature.size * 0.25, -feature.size * 0.18);
      context.stroke();
    } else if (feature.type < 0.82) {
      context.fillStyle = "#151a16a0";
      context.beginPath();
      context.ellipse(4, 5, feature.size, feature.size * 0.62, 0, 0, Math.PI * 2);
      context.fill();
      for (const [x, y, scale] of [[-0.4, 0.05, 0.6], [0.18, -0.25, 0.72], [0.45, 0.2, 0.52]]) {
        context.fillStyle = "#3e4b36";
        context.beginPath();
        context.arc(feature.size * x, feature.size * y, feature.size * scale * 0.58, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "#697858";
        context.beginPath();
        context.arc(feature.size * x - 2, feature.size * y - 3, feature.size * scale * 0.31, 0, Math.PI * 2);
        context.fill();
      }
    } else {
      context.fillStyle = "#1d211e";
      context.fillRect(-feature.size * 0.7 + 4, -feature.size * 0.22 + 4, feature.size * 1.5, feature.size * 0.48);
      context.fillStyle = "#765744";
      context.fillRect(-feature.size * 0.7, -feature.size * 0.22, feature.size * 1.5, feature.size * 0.48);
      context.fillStyle = "#b28a5d";
      context.fillRect(-feature.size * 0.7 + 3, -feature.size * 0.22 + 2, feature.size * 0.62, 2);
      context.fillStyle = "#30342e";
      context.fillRect(-feature.size * 0.38, -feature.size * 0.55, 2, feature.size * 1.05);
    }
    context.restore();
  }
}

function drawZone(zone) {
  context.save();
  context.fillStyle = "#211a1b66";
  context.beginPath();
  context.rect(0, 0, state.worldSize, state.worldSize);
  context.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2, true);
  context.fill("evenodd");
  context.strokeStyle = "#a63f33aa";
  context.lineWidth = 10;
  context.beginPath();
  context.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = "#f1a45c";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawPickup(pickup) {
  context.save();
  context.translate(pickup.x, pickup.y);
  context.fillStyle = "#13171288";
  context.beginPath();
  context.ellipse(2, 9, 14, 8, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#c89448";
  context.fillRect(-11, -8, 22, 19);
  context.fillStyle = "#ecc27c";
  context.fillRect(-11, -8, 22, 4);
  context.fillStyle = "#51422e";
  context.fillRect(-2, -8, 4, 19);
  context.strokeStyle = "#171a17";
  context.lineWidth = 2;
  context.strokeRect(-11, -8, 22, 19);
  context.restore();
  context.fillStyle = "#f1d89f";
  context.font = "bold 9px sans-serif";
  context.textAlign = "center";
  context.fillText(`${pickup.weapon + 1}`, pickup.x, pickup.y + 3);
}

function drawBullet(bullet) {
  context.strokeStyle = `${bullet.color}99`;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(bullet.x - bullet.vx * 0.018, bullet.y - bullet.vy * 0.018);
  context.lineTo(bullet.x, bullet.y);
  context.stroke();
  context.fillStyle = `${bullet.color}44`;
  context.beginPath();
  context.arc(bullet.x, bullet.y, 7, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = bullet.color;
  context.beginPath();
  context.arc(bullet.x, bullet.y, 4, 0, Math.PI * 2);
  context.fill();
}

function drawPlayer(player) {
  if (!player.alive) return;
  const rendered = renderPlayers.get(player.id) || player;
  const px = rendered.x;
  const py = rendered.y;
  const pangle = rendered.angle;
  const index = state.players.findIndex((item) => item.id === player.id);
  const paletteIndex = index % ARMOR_PALETTES.length;
  context.save();
  context.translate(px, py);
  context.rotate(pangle);
  if (player.id === myId) {
    context.strokeStyle = "#d4e5acaa";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(0, 0, 23, 0, Math.PI * 2);
    context.stroke();
  }
  context.drawImage(soldierSprites[paletteIndex], -32, -32);
  context.drawImage(weaponSprites[player.weapon] || weaponSprites[0], -32, -32);
  context.restore();
  context.font = "11px sans-serif";
  context.textAlign = "center";
  context.lineWidth = 3;
  context.strokeStyle = "#111512";
  context.strokeText(player.name, px, py - 27);
  context.fillStyle = "#f0eee3";
  context.fillText(player.name, px, py - 23);
  if (player.id === myId) {
    context.font = "10px sans-serif";
    context.fillStyle = "#f0b5a3";
    context.fillText("♥".repeat(player.lives), px, py + 33);
  }
}

function drawVignette(width, height) {
  const gradient = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.24, width / 2, height / 2, Math.max(width, height) * 0.72);
  gradient.addColorStop(0, "#10140c00");
  gradient.addColorStop(1, "#0b0d0c55");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function drawPlayerGlow(player, width, height) {
  if (!player?.alive) return;
  const x = player.x - camera.x;
  const y = player.y - camera.y;
  const light = context.createRadialGradient(x, y, 14, x, y, 250);
  light.addColorStop(0, "#e3d8ad1c");
  light.addColorStop(1, "#d5c69500");
  context.globalCompositeOperation = "screen";
  context.fillStyle = light;
  context.fillRect(Math.max(0, x - 250), Math.max(0, y - 250), Math.min(500, width), Math.min(500, height));
  context.globalCompositeOperation = "source-over";
}

function drawMinimap() {
  const width = minimap.clientWidth;
  const height = minimap.clientHeight;
  mapContext.clearRect(0, 0, width, height);
  mapContext.fillStyle = "#17221c";
  mapContext.fillRect(0, 0, width, height);
  const scale = width / state.worldSize;
  mapContext.fillStyle = "#514c3e";
  mapContext.fillRect(state.worldSize * 0.35 * scale - 2, 0, 4, height);
  mapContext.fillRect(0, state.worldSize * 0.66 * scale - 2, width, 4);
  for (const feature of mapFeatures) {
    mapContext.fillStyle = feature.type < 0.28 ? "#6d6c5a88" : feature.type < 0.59 ? "#85817488" : "#47544388";
    mapContext.fillRect(feature.x * scale, feature.y * scale, 1.5, 1.5);
  }
  mapContext.strokeStyle = "#edaf69";
  mapContext.lineWidth = 1.5;
  mapContext.beginPath();
  mapContext.arc(state.zone.x * scale, state.zone.y * scale, state.zone.radius * scale, 0, Math.PI * 2);
  mapContext.stroke();
  for (const player of state.players) {
    if (!player.alive) continue;
    mapContext.fillStyle = player.id === myId ? "#efffb6" : "#ff938d";
    mapContext.beginPath();
    mapContext.arc(player.x * scale, player.y * scale, player.id === myId ? 3 : 2, 0, Math.PI * 2);
    mapContext.fill();
  }
}

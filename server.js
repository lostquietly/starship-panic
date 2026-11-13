import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const httpServer = createServer(app);
const io = new Server(httpServer);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post("/api/token", async (req, res) => {
  try {
    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: req.body.code,
      }),
    });
    const data = await response.json();
    res.send({ access_token: data.access_token });
  } catch (err) {
    res.status(500).send({ error: "Token exchange failed" });
  }
});

const rooms = {};

const ALL_MODULES = [
  { id: "thrusters", name: "Main Thrusters", type: "slider", target: 75, value: 50, unit: "%" },
  { id: "coolant", name: "Core Coolant", type: "toggle", target: true, value: false },
  { id: "gyro", name: "Gyro Stabilizer", type: "slider", target: 30, value: 50, unit: "°" },
  { id: "hyperdrive", name: "Hyperdrive Valve", type: "button", target: "PRIMED", value: "IDLE" },
  { id: "shields", name: "Deflector Shields", type: "toggle", target: false, value: true },
  { id: "radar", name: "Subspace Frequency", type: "slider", target: 90, value: 20, unit: "MHz" }
];

function createNewTask(room) {
  const playerIds = Object.keys(room.players);
  if (playerIds.length === 0) return;

  const mod = room.modules[Math.floor(Math.random() * room.modules.length)];
  if (mod.type === "slider") {
    mod.target = [15, 30, 45, 60, 75, 90][Math.floor(Math.random() * 6)];
  } else if (mod.type === "toggle") {
    mod.target = !mod.value;
  } else {
    mod.target = mod.value === "IDLE" ? "PRIMED" : "IDLE";
  }

  const ownerIndex = playerIds.indexOf(mod.ownerId);
  const messengerId = playerIds[(ownerIndex + 1) % playerIds.length];

  room.currentAlert = {
    moduleId: mod.id,
    moduleName: mod.name,
    ownerName: room.players[mod.ownerId]?.username || "Crewmate",
    messengerId,
    instruction:
      mod.type === "slider"
        ? `Set ${mod.name} to ${mod.target}${mod.unit}!`
        : mod.type === "toggle"
        ? `Flip ${mod.name} to ${mod.target ? "ON" : "OFF"}!`
        : `Cycle ${mod.name} to ${mod.target}!`,
  };
}

function assignModules(room) {
  const playerIds = Object.keys(room.players);
  if (playerIds.length === 0) return;
  room.modules = ALL_MODULES.map((m, idx) => ({
    ...m,
    ownerId: playerIds[idx % playerIds.length],
  }));
}

async function generateSecretPlanet(room) {
  try {
    const prompt = `A clumsy ${Object.keys(room.players).length}-person spaceship crew went completely off-course while flying to Mars! Invent a funny, weird Secret Planet they accidentally crash-landed on. Return ONLY valid JSON with keys: "planetName", "hazardDescription", and "captainRoast" (1 short funny sentence roasting their terrible teamwork).`;
    const response = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    return JSON.parse(response.text);
  } catch (e) {
    return {
      planetName: "Planet Blunder-9",
      hazardDescription: "Gravity is upside down and the fuel smells like burnt toast.",
      captainRoast: "Next time, try listening to each other instead of mashing buttons.",
    };
  }
}

io.on("connection", (socket) => {
  socket.on("join-ship", ({ instanceId, user }) => {
    const roomId = instanceId || "default-room";
    socket.join(roomId);
    socket.roomId = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        modules: [],
        distance: 0,
        drift: 0,
        status: "LOBBY",
        currentAlert: null,
        secretPlanet: null,
      };
    }

    rooms[roomId].players[socket.id] = { id: socket.id, username: user.username };
    assignModules(rooms[roomId]);
    io.to(roomId).emit("state-update", rooms[roomId]);
  });

  socket.on("start-mission", () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.status = "FLYING";
    room.distance = 0;
    room.drift = 0;
    room.secretPlanet = null;
    assignModules(room);
    createNewTask(room);
    io.to(socket.roomId).emit("state-update", room);
  });

  socket.on("update-control", async ({ moduleId, newValue }) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== "FLYING") return;

    const mod = room.modules.find((m) => m.id === moduleId);
    if (!mod) return;
    mod.value = newValue;

    if (room.currentAlert && room.currentAlert.moduleId === moduleId && mod.value === mod.target) {
      room.distance += 20;
      if (room.distance >= 100) {
        room.status = "VICTORY";
      } else {
        createNewTask(room);
      }
    } else if (room.currentAlert && room.currentAlert.moduleId !== moduleId) {
      room.drift += 35;
      if (room.drift >= 100) {
        room.status = "SECRET_PLANET";
        io.to(socket.roomId).emit("state-update", room);
        room.secretPlanet = await generateSecretPlanet(room);
      }
    }

    io.to(socket.roomId).emit("state-update", room);
  });

  socket.on("disconnect", () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    delete room.players[socket.id];
    assignModules(room);
    io.to(socket.roomId).emit("state-update", room);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Starship Panic running on ${PORT}`));

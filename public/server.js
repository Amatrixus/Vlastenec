const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = 3000;
const MAX_PLAYERS = 3;

const playerSlots = {};           // number (1–3) -> name
const socketToNumber = {};        // socket.id -> number

io.on('connection', socket => {
  console.log(`✅ ${socket.id} connected`);

  socket.on("submitName", name => {
    if (Object.keys(playerSlots).length >= MAX_PLAYERS) {
      socket.emit("spectator");
      return;
    }

    // Najdi první volné číslo hráče
    let assignedNumber;
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!playerSlots[i]) {
        assignedNumber = i;
        break;
      }
    }

    playerSlots[assignedNumber] = name;
    socketToNumber[socket.id] = assignedNumber;

    const allNames = { ...playerSlots };

    socket.emit("assignPlayerNumber", {
      number: assignedNumber,
      allNames
    });
    
    // Všem ostatním pošli jen aktualizaci jmen
    socket.broadcast.emit("updatePlayers", {
      allNames
    });

    // Zajisti, že každý klient má aktuální seznam všech hráčů
    io.emit("updatePlayers", { allNames });



    // Výpis seznamu hráčů do konzole
    console.log("📋 Aktuální hráči:");
    console.table(playerSlots);
  });

  socket.on("disconnect", () => {
    const number = socketToNumber[socket.id];
    if (number) {
      delete playerSlots[number];
      delete socketToNumber[socket.id];
    }
    console.log(`❌ ${socket.id} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
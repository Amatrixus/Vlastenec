const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');




const app = express();
app.use(express.static('public')); // servíruje index.html a další soubory

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } }); // (později si omezíš)



const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server běží na', PORT));






const MAX_PLAYERS_PER_ROOM = 3;
const rooms = {}; // roomId -> { players, scores, bases, regions, regionValues, defenseBonuses }













function makeEmptyRoom(roomId, mode = 'random') {
  rooms[roomId] = {
    mode,                  // ← důležité
    players: [],
    scores: { 1: 0, 2: 0, 3: 0 },
    bases: {},
    regions: { Player1regions: [], Player2regions: [], Player3regions: [] },
    regionValues: { ...defaultRegionValues },
    defenseBonuses: { Player1: 0, Player2: 0, Player3: 0 },
    playerLives: { Player1: 3, Player2: 3, Player3: 3 },
    chat: [],
    settings: {}           // volitelné – můžeš sem ukládat cats/catNames
  };
  return rooms[roomId];
}




// 🔴 NEW – helpery pro řízení životního cyklu místnosti
function markRoomClosed(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.__closed = true;
}

function isRoomAlive(roomId) {
  const room = rooms[roomId];
  return !!room && room.__closed !== true;
}

// Volitelné: místo běžného delay použijeme cancellable delay
async function delayAlive(roomId, ms) {
  const step = 50;
  let waited = 0;
  while (waited < ms) {
    if (!isRoomAlive(roomId)) return false; // zrušeno
    await new Promise(r => setTimeout(r, Math.min(step, ms - waited)));
    waited += step;
  }
  return true; // doběhlo celé
}






function roomAddPlayerAndBroadcast(roomId, socket, name) {
  const room = rooms[roomId];
  if (!room) return;

  // ✅ už v místnosti? nic nepřidávej
  if (room.players.some(p => p.id === socket.id)) {
    return;
  }

  const myNumber = room.players.length + 1;

  socket.join(roomId);
  room.players.push({ id: socket.id, name });

  const allNames = {};
  room.players.forEach((p, index) => { allNames[index + 1] = p.name; });

  socket.emit("assignPlayerNumber", {
    number: myNumber,
    allNames,
    scores: room.scores,
    roomId
  });

  io.to(roomId).emit("updatePlayers", { allNames });
  io.to(roomId).emit("updateScores", { scores: room.scores });

  // ✅ pošleme historii chatu nově připojenému hráči
  socket.emit("chat:history", room.chat ?? []);

  // Když je plno, nastartuj hru (původní logika)
  if (room.players.length === MAX_PLAYERS_PER_ROOM) {
    const possibleBases = ['Rho', 'Omega', 'Theta'];
    const shuffled = possibleBases.sort(() => Math.random() - 0.5);

    room.bases[1] = shuffled[0];
    room.bases[2] = shuffled[1];
    room.bases[3] = shuffled[2];

    room.regions.Player1regions = [room.bases[1]];
    room.regions.Player2regions = [room.bases[2]];
    room.regions.Player3regions = [room.bases[3]];

    room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

    io.to(roomId).emit("startGame", {
      bases: room.bases,
      regions: room.regions,
      regionValues: room.regionValues
    });

    io.to(roomId).emit("updateScores", { scores: room.scores });

    
    
    if (room.players.length === MAX_PLAYERS_PER_ROOM && isRoomAlive(roomId)) {


          runGameScenario(roomId);
    }
  
  
  }
}














const defaultRegionValues = {
  Alpha: 0,
  Delta: 0,
  Epsilon: 0,
  Zeta: 0,
  Eta: 0,
  Theta: 0,
  Kappa: 0,
  Lambda: 0,
  Mu: 0,
  Nu: 0,
  Omicron: 0,
  Pi: 0,
  Rho: 0,
  Sigma: 0,
  Omega: 0
};

const adjacencyInfo = {
  Alpha: ['Sigma', 'Zeta', 'Epsilon', 'Pi', 'Omicron', 'Nu', 'Mu', 'Eta'],
  Delta: ['Theta', 'Eta', 'Mu', 'Omicron'],
  Epsilon: ['Alpha','Zeta', 'Kappa', 'Rho', 'Pi'],
  Zeta: ['Alpha','Sigma', 'Epsilon'],
  Eta: ['Alpha','Sigma', 'Delta', 'Theta', 'Mu'],
  Theta: ['Eta', 'Delta'],
  Kappa: ['Omega', 'Lambda', 'Rho', 'Epsilon'],
  Lambda: ['Omega', 'Kappa', 'Rho'],
  Mu: ['Alpha', 'Delta', 'Eta', 'Omicron', 'Nu'],
  Nu: ['Alpha','Mu'],
  Omicron: ['Alpha','Delta', 'Mu', 'Pi', 'Rho'],
  Pi: ['Alpha','Rho', 'Epsilon', 'Omicron'],
  Rho: ['Lambda', 'Kappa','Epsilon','Pi','Omicron'],
  Sigma: ['Alpha','Eta','Zeta'],
  Omega: ['Kappa', 'Lambda']
};




// Spočítá skóre hráčů
function calculateScores(regions, values, bonuses) {
  const scores = { 1: 0, 2: 0, 3: 0 };
  for (let p = 1; p <= 3; p++) {
    const key = `Player${p}regions`;
    const owned = regions[key] || [];
    owned.forEach(region => {
      scores[p] += values[region] || 0;
    });
    scores[p] += bonuses[`Player${p}`] || 0;
  }
  return scores;
}

// Generuje plán rozšiřování (pořadí hráčů)
function generateExpansionPlan() {
  const baseOrders = [
    [1, 2, 3],
    [2, 3, 1],
    [3, 1, 2],
    [2, 1, 3],
    [3, 2, 1],
    [1, 3, 2]
  ];
  const shuffledRounds = [];
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * baseOrders.length);
    shuffledRounds.push([...baseOrders[randomIndex]]);
  }
  return shuffledRounds;
}


// Generuje plán bitev (pořadí hráčů)
function generateBattlePlan() {
  const baseOrders = [
    [1, 2, 3],
    [2, 3, 1],
    [3, 1, 2],
    [2, 1, 3],
    [3, 2, 1],
    [1, 3, 2]
  ];
  const shuffledRounds = [];
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * baseOrders.length);
    shuffledRounds.push([...baseOrders[randomIndex]]);
  }
  return shuffledRounds;
}


//Funkce na počítání obsazených polí

function countOccupiedRegions(room) {
  return (
    room.regions.Player1regions.length +
    room.regions.Player2regions.length +
    room.regions.Player3regions.length
  );
}

// Pomocná delay funkce
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}




// OTÁZKY


const questionsPath = path.join(__dirname, 'multiple_choice_questions.json');
const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));


// --- Numeric Qs (CJS) ---
const numericQuestionsPath = path.join(__dirname, 'numeric_questions.json');
const numericQuestions = JSON.parse(fs.readFileSync(numericQuestionsPath, 'utf8'));


module.exports = { questions }; // pokud exportuješ dál






function runMultipleChoice(roomId, participatingPlayers = [1, 2, 3]) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve([]);

    const question = questions[Math.floor(Math.random() * questions.length)];
    const correctPlayers = [];

    room.answers = {};

    console.log(`❓ Spouštím otázku: "${question.question}" pro hráče: ${participatingPlayers}`);

    const isDuel = participatingPlayers.length === 2;
    const attacker = isDuel ? participatingPlayers[0] : null;
    const defender = isDuel ? participatingPlayers[1] : null;

    // ✅ Pošli všem hráčům otázku – třetí hráč jen neinteraguje
    room.players.forEach((p, index) => {
      const playerNumber = index + 1;
      io.to(p.id).emit("multipleChoiceQuestion", {
        question: question.question,
        options: question.options,
        time: 10,
        attacker,
        defender,
        attackerName: isDuel ? room.players[attacker - 1].name : "",
        defenderName: isDuel ? room.players[defender - 1].name : "",
        canAnswer: participatingPlayers.includes(playerNumber) // ✅ nový klíč
      });
    });

    const handler = ({ room: rId, player, answerIndex }) => {
      if (rId !== roomId) return;
      if (!participatingPlayers.includes(player)) return;
      if (room.answers[player] !== undefined) return;

      room.answers[player] = answerIndex;
      console.log(`✏️ Hráč ${player} odpověděl: ${answerIndex}`);
    };

    io.on("playerAnswered", handler);

    setTimeout(() => {
      io.off("playerAnswered", handler);

      if (!isRoomAlive(roomId)) return resolve([]); // 🔴 NEW


      for (const player in room.answers) {
        if (room.answers[player] === question.correct) {
          correctPlayers.push(Number(player));
        }
      }

      console.log(`✅ Správně odpověděli: ${correctPlayers}`);

      io.to(roomId).emit("multipleChoiceResults", {
        correctAnswer: question.correct,
        answersByPlayer: room.answers
      });

      resolve(correctPlayers);
    }, 10000);
  });
}





function runNumericQuestionForTwo(roomId, [player1, player2]) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve(null);

    // Vyber náhodnou otázku z JSONu
    const nq = numericQuestions[Math.floor(Math.random() * numericQuestions.length)];
    const correctAnswer = Number.isInteger(nq.answer) ? nq.answer : parseInt(nq.answer, 10);

    console.log(`❓ Numerická (duel) ${player1} vs ${player2}: ${nq.question} → správně: ${correctAnswer}`);

    room.numericAnswers = {};
    room.numericStartTime = Date.now();

    io.to(roomId).emit("numericQuestionForTwo", {
      question: nq.question,  // <— posíláme text otázky
      time: 15,
      attacker: player1,
      defender: player2,
      attackerName: room.players[player1 - 1].name,
      defenderName: room.players[player2 - 1].name
    });

    const handler = ({ room: rId, player, answer }) => {
      if (rId !== roomId) return;
      if (![player1, player2].includes(player)) return;

      // zkonvertuj vstup na celé číslo
      const num = parseInt(answer, 10);
      if (Number.isNaN(num)) return;

      if (!room.numericAnswers[player]) {
        room.numericAnswers[player] = {
          num,
          time: Date.now() - room.numericStartTime
        };
        console.log(`✏️ Hráč ${player} odpověděl: ${num} (${room.numericAnswers[player].time}ms)`);
      }
    };

    io.on("playerNumericAnswer", handler);

    setTimeout(() => {
      io.off("playerNumericAnswer", handler);

      // doplň chybějící odpovědi
      [player1, player2].forEach(p => {
        if (!room.numericAnswers[p]) {
          room.numericAnswers[p] = { num: 0, time: 15000 };
          console.log(`⏳ Hráč ${p} nestihl → nastavena odpověď 0 (15 s)`);
        }
      });

      const sorted = Object.entries(room.numericAnswers)
        .map(([player, data]) => ({
          player: Number(player),
          num: data.num,
          diff: Math.abs(data.num - correctAnswer),
          time: data.time
        }))
        .sort((a, b) => (a.diff !== b.diff ? a.diff - b.diff : a.time - b.time));

      const winner = sorted[0].player;

      console.log(`🏆 Vítěz (duel): Hráč ${winner}`);

      io.to(roomId).emit("numericQuestionResultsForTwo", {
        correctAnswer,
        attacker: player1,
        defender: player2,
        answers: sorted.map(a => ({
          player: a.player,
          num: a.num,
          time: a.time,
          name: room.players[a.player - 1].name
        }))
      });

      resolve(winner);
    }, 15000);
  });
}




function runNumericQuestionForThree(roomId) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve(null);

    const nq = numericQuestions[Math.floor(Math.random() * numericQuestions.length)];
    const correctAnswer = Number.isInteger(nq.answer) ? nq.answer : parseInt(nq.answer, 10);

    console.log(`❓ Numerická (3 hráči): ${nq.question} → správně: ${correctAnswer}`);

    room.numericAnswers = {};
    room.numericStartTime = Date.now();

    io.to(roomId).emit("numericQuestion", {
      question: nq.question, // <— text otázky
      time: 15
    });

    const handler = ({ room: rId, player, answer }) => {
      if (rId !== roomId) return;
      const num = parseInt(answer, 10);
      if (Number.isNaN(num)) return;

      if (!room.numericAnswers[player]) {
        room.numericAnswers[player] = {
          num,
          time: Date.now() - room.numericStartTime
        };
        console.log(`✏️ Hráč ${player} odpověděl: ${num} (${room.numericAnswers[player].time}ms)`);
      }
    };

    io.on("playerNumericAnswer", handler);

    setTimeout(() => {
      io.off("playerNumericAnswer", handler);

      // doplň neodpověděné
      [1, 2, 3].forEach(player => {
        if (!room.numericAnswers[player]) {
          room.numericAnswers[player] = { num: 0, time: 15000 };
          console.log(`⏳ Hráč ${player} nestihl → 0 (15 s)`);
        }
      });

      const sorted = Object.entries(room.numericAnswers)
        .map(([player, data]) => ({
          player: Number(player),
          num: data.num,
          diff: Math.abs(data.num - correctAnswer),
          time: data.time
        }))
        .sort((a, b) => (a.diff !== b.diff ? a.diff - b.diff : a.time - b.time));

      const winner = sorted[0].player;

      console.log(`🏆 Vítěz (3 hráči): Hráč ${winner}`);

      io.to(roomId).emit("numericQuestionResults", {
        correctAnswer,
        answers: sorted
      });

      resolve(winner);
    }, 15000);
  });
}







/* JEN BITVY


async function runGameScenario(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  console.log("⏩ Přeskakuji rozšiřování a dobývání – test bitev!");

  const allRegions = Object.keys(room.regionValues);
  const p1 = [];
  const p2 = [];
  const p3 = [];

  room.bases = {}; // ✅ Zajistíme, že existuje

  allRegions.forEach((region, i) => {
    if (i % 3 === 0) {
      p1.push(region);
      if (i === 0) {
        room.regionValues[region] = 1000;
        room.bases[1] = region; // ✅ Ulož jako základnu hráče 1
      } else {
        room.regionValues[region] = 200;
      }
    } else if (i % 3 === 1) {
      p2.push(region);
      if (i === 1) {
        room.regionValues[region] = 1000;
        room.bases[2] = region; // ✅ Základna hráče 2
      } else {
        room.regionValues[region] = 200;
      }
    } else {
      p3.push(region);
      if (i === 2) {
        room.regionValues[region] = 1000;
        room.bases[3] = region; // ✅ Základna hráče 3
      } else {
        room.regionValues[region] = 200;
      }
    }
  });

  room.regions.Player1regions = p1;
  room.regions.Player2regions = p2;
  room.regions.Player3regions = p3;

  room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

  io.to(roomId).emit("updateRegions", {
    regions: room.regions,
    regionValues: room.regionValues,
    scores: room.scores
  });

  // ✅ Můžeš volitelně poslat klientům základny, pokud je potřebují vizuálně
  io.to(roomId).emit("startGame", {
    bases: room.bases,
    regions: room.regions,
    regionValues: room.regionValues
  });

  console.log("📌 Regiony připravené pro test bitev:", room.regions);
  console.log("🏰 Základny nastaveny:", room.bases);

  await runBattlePhase(roomId);
}


*/


/* CELÁ HRA  */

// Scénář po startGame
async function runGameScenario(roomId) {


  if (!isRoomAlive(roomId)) return; // 🔴 NEW
  const room = rooms[roomId];
  if (!room) return;


    if (!await delayAlive(roomId, 7000)) return; // 🔴 NEW

  //FÁZE USAZENÍ
      io.to(roomId).emit("runClientScenario", { action: "basesSettle" });
       if (!await delayAlive(roomId, 8000)) return; // 🔴 NEW

  //INTRO K ROZŠIŘOVÁNÍ

       if (!isRoomAlive(roomId)) return; // 🔴 NEW
      //VYGENEROVÁNÍ HERNÍHO PLÁNU
        const expansionPlan = generateExpansionPlan();
        const room = rooms[roomId]; // může být bezpečně undefined, ale nahoře jsme ověřili
        if (!room) return;
        room.expansionPlan = expansionPlan;

      //POSLÁNÍ PLÁNU KLIENTŮM
      io.to(roomId).emit("runClientScenario", {
        action: "expansionintro",
        expansionPlan
      });

      console.log("🧭 Odeslán expansionPlan:", expansionPlan);
      if (!await delayAlive(roomId, 2000)) return; // 🔴 NEW

      //FÁZE ROZŠIŘOVÁNÍ
      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      await runExpansionPhase(roomId);

      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      await runConquestPhase(roomId);

      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      await runBattlePhase(roomId);

}








async function runExpansionPhase(roomId) {
  const room = rooms[roomId];
    if (!room || !isRoomAlive(roomId)) return; // 🔴 NEW


  for (let round = 1; round <= 6; round++) {

    if (!isRoomAlive(roomId)) return; // 🔴 NEW
    room.claimedRegionsThisRound = new Set();

    io.to(roomId).emit("startExpansionRound", {
      round,
      order: room.expansionPlan[round - 1]
    });

    console.log(`🔵 Kolo ${round} začíná – pořadí:`, room.expansionPlan[round - 1]);

    

    await runPlayerTurns(roomId, round, room.expansionPlan[round - 1]);
    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    const correctPlayers = await runMultipleChoice(roomId);
    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    if (!await delayAlive(roomId, 6000)) return; // 🔴 NEW


    correctPlayers.forEach(player => {
      const selectedRegion = room.lastSelections[player];
      if (selectedRegion) {
        room.regions[`Player${player}regions`].push(selectedRegion);
        room.regionValues[selectedRegion] = 200;
        room.scores[player] += 200;
        console.log(`✅ Hráč ${player} získal region ${selectedRegion} (+200 bodů)`);
        io.to(roomId).emit("updateScores", { scores: room.scores });

      }
    });

    // Aktualizace klientů
    io.to(roomId).emit("updateRegions", {
      regions: room.regions,
      regionValues: room.regionValues,
      scores: room.scores
    });



    console.log(`✅ Kolo ${round} dokončeno`);

    if (countOccupiedRegions(room) > 12) {
        console.log(`🛑 Fáze rozšiřování ukončena – obsazeno ${countOccupiedRegions(room)} polí.`);
        break;
    }
  }

  console.log("🟢 Fáze rozšiřování dokončena");
}













async function runConquestPhase(roomId) {
  const room = rooms[roomId];
  if (!room || !isRoomAlive(roomId)) return; // 🔴 NEW

  console.log("⚔️ Fáze dobývání spuštěna!");
  io.to(roomId).emit("phaseChange", { phase: "conquest" });


  let takenTiles = countOccupiedRegions(room);
  let round = 1;

  while (takenTiles < Object.keys(room.regionValues).length) {

    if (!isRoomAlive(roomId)) return; // 🔴 NEW

    console.log(`⚔️ Dobývání – ${round}. kolo (obsazeno: ${takenTiles})`);

    // 1️⃣ Intro pro klienty – animace a název kola
    io.to(roomId).emit("conquestIntro", {
      round,
      title: `Dobývání – ${round}. kolo`
    });
    if (!await delayAlive(roomId, 4000)) return; // 🔴 NEW

    // 2️⃣ Numerická otázka – vítěz
    const winner = await runNumericQuestionForThree(roomId);
    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    if (winner) {
      console.log(`🏆 Hráč ${winner} vyhrál numerickou otázku`);

      // 3️⃣ Počkej na animaci výsledků na klientovi (stejně jako offline verze)
      if (!await delayAlive(roomId, 6000)) return; // 🔴 NEW

      // 4️⃣ Získej dostupné regiony pro vítěze
      const available = getAvailableRegionsConquest(room);
      const playerSocketId = room.players[winner - 1].id;

      // Pošli seznam dostupných polí pouze vítězi
      io.to(playerSocketId).emit("availableRegions", { regions: available });


      console.log("📊 Dostupná pole pro hráče", winner, ":", getAvailableRegionsConquest(room));
      console.log("📌 Regions:", room.regions);
      console.log("📌 RegionValues:", room.regionValues);


      // Čekej na výběr regionu nebo náhodné přiřazení
      const selectedRegion = await waitForPlayerSelection(roomId, winner, 10000);
      if (!isRoomAlive(roomId)) return; // 🔴 NEW


      if (selectedRegion) {
        // ✅ Okamžitě zobraz pin na mapě všem hráčům
        io.to(roomId).emit("playerSelectedRegion", {
          player: winner,
          region: selectedRegion
        });

        // ✅ Přiděl region a přepočítej body
        room.regions[`Player${winner}regions`].push(selectedRegion);
        room.regionValues[selectedRegion] = 300;
        room.scores[winner] += 300;

        console.log(`✅ Hráč ${winner} obsadil ${selectedRegion} (+300 bodů)`);

      await delayAlive(roomId, 2000); // 🔴 NEW

        // ✅ Aktualizace pro všechny hráče (zabarvení + skóre)
        io.to(roomId).emit("updateRegions", {
          regions: room.regions,
          regionValues: room.regionValues,
          scores: room.scores
        });

        io.to(roomId).emit("updateScores", { scores: room.scores });

        takenTiles++;
      }
    } else {
      console.log("⏳ Nikdo neodpověděl správně – kolo bez změny");
    }

    round++;
  }

  console.log("🟢 Fáze dobývání dokončena!");

}







async function runBattlePhase(roomId) {
  const room = rooms[roomId];
  if (!room || !isRoomAlive(roomId)) return; // 🔴 NEW

  console.log("⚔️ Fáze bitev spuštěna!");

  const battlePlan = generateBattlePlan();
  room.battlePlan = battlePlan;

  // ✅ Pošli battlePlan klientům, aby si vykreslili tyčky
  io.to(roomId).emit("battleIntro", {
    battlePlan,
    title: "Bitvy"
  });

  console.log("📋 BattlePlan:", battlePlan);

  for (let round = 1; round <= 6; round++) {
    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    io.to(roomId).emit("startBattleRound", {
      round,
      order: room.battlePlan[round - 1]
    });

    console.log(`🔵 Bitvy – ${round}. kolo`);

    for (let battlestick = 1; battlestick <= 3; battlestick++) {
      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      const attacker = room.battlePlan[round - 1][battlestick - 1];

      io.to(roomId).emit("updateBattleStick", {
        round,
        battlestick,
        player: attacker
      });

      console.log(`🎯 Tah ${battlestick} v ${round}. kole`);

      if (isAnyoneWinning(room)) {
        console.log("🏆 Někdo vyhrál – bitvy končí!");

                  
            const finalScores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

            // Získání pořadí (seřazeno podle skóre)
            const ordered = Object.entries(finalScores)
              .map(([player, score]) => ({ player: Number(player), score }))
              .sort((a, b) => b.score - a.score);

            io.to(roomId).emit("gameOver", {
              message: "Hra skončila!",
              finalScores: ordered // obsahuje pole objektů: { player: 1, score: ... }, seřazeno
            });

  


        return;
      }

      const selections = await runBattleClaiming(roomId, attacker);
      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      if (!selections) continue;

      const { claimedBy, currentlyOwnedBy, selectedRegion } = selections;
      console.log(`📌 Bitva: Útočník ${claimedBy} → Napadá ${selectedRegion} (majitel ${currentlyOwnedBy})`);

      if (!selectedRegion) continue;

      await runBattleOnRegion(roomId, claimedBy, currentlyOwnedBy, selectedRegion);

      if (!await delayAlive(roomId, 2000)) return; // 🔴 NEW
    }
  }

  console.log("🟢 Fáze bitev dokončena!");
}



async function runBattleClaiming(roomId, attacker) {
  const room = rooms[roomId];
  if (!room) return null;

  console.log(`🎯 Hráč ${attacker} vybírá soupeřovo území k útoku`);

  const availableEnemyRegions = getEnemyRegions(room, attacker);

  if (availableEnemyRegions.length === 0) {
    console.log(`⚠️ Hráč ${attacker} nemá co napadnout`);
    return null;
  }

  const attackerSocketId = room.players[attacker - 1].id;
  io.to(attackerSocketId).emit("battleAvailableRegions", { regions: availableEnemyRegions });

  const selectedRegion = await waitForPlayerSelection(roomId, attacker, 10000, availableEnemyRegions);

  if (!selectedRegion) {
    console.log(`⏳ Hráč ${attacker} nestihl vybrat → kolo se přeskočí`);
    return null;
  }

  // ✅ Okamžitě zobraz pin na mapě
  io.to(roomId).emit("playerSelectedRegion", {
    player: attacker,
    region: selectedRegion
  });

  // ✅ Pauza, aby si všichni prohlédli pin (např. 2 s)
  await delay(2000);

  // Najdeme majitele regionu
  let participant2 = null;
  for (let p = 1; p <= 3; p++) {
    if (room.regions[`Player${p}regions`].includes(selectedRegion)) {
      participant2 = p;
      break;
    }
  }

  console.log(`⚔️ Útočník ${attacker} → Napadá region ${selectedRegion} (majitel: ${participant2})`);

  return {
    claimedBy: attacker,
    currentlyOwnedBy: participant2,
    selectedRegion
  };
}




function getEnemyRegions(room, attacker) {
  const owned = room.regions[`Player${attacker}regions`] || [];
  const allEnemyRegions = [];

  for (let p = 1; p <= 3; p++) {
    if (p === attacker) continue;

    const enemyRegions = room.regions[`Player${p}regions`] || [];

    enemyRegions.forEach(region => {
      // ✅ Útočit lze jen na regiony, které sousedí s některým z útočníkových regionů
      if (
        owned.some(ownedRegion =>
          adjacencyInfo[ownedRegion]?.includes(region)
        )
      ) {
        allEnemyRegions.push(region);
      }
    });
  }

console.log(`▶️ getEnemyRegions: Attacker ${attacker}`);
console.log(`  Owned:`, owned);
console.log(`  Regions P1:`, room.regions.Player1regions);
console.log(`  Regions P2:`, room.regions.Player2regions);
console.log(`  Regions P3:`, room.regions.Player3regions);

console.log("ALL AVAILABLE ENEMY REGIONS", allEnemyRegions)

  return allEnemyRegions;




}




async function runBattleOnRegion(roomId, attacker, defender, region) {
  const room = rooms[roomId];
  if (!room) return;

  const isBase = region === room.bases[defender];
  console.log(`⚔️ Bitva o region ${region} mezi Hráčem ${attacker} (útočník) a Hráčem ${defender} (obránce)`);

  if (isBase) {
    const lives = room.playerLives[`Player${defender}`] || 3;
    io.to(roomId).emit("showBaseMini", { attacker, defender, lives });
    await delay(1000);
  }

  // 1. BĚŽNÉ POLE → žádná smyčka, jen jedna otázka
  if (!isBase) {
    const correctPlayers = await runMultipleChoice(roomId, [attacker, defender]);
    
    await delay(5000);

    let winner = null;

    if (correctPlayers.length === 1) {
      winner = correctPlayers[0];
    } else if (correctPlayers.length > 1) {
      await delay(2000);
      winner = await runNumericQuestionForTwo(roomId, [attacker, defender]);
      await delay(3000);
    }

    if (winner === attacker) {
      const defKey = `Player${defender}regions`;
      const atkKey = `Player${attacker}regions`;
      const index = room.regions[defKey].indexOf(region);
      if (index !== -1) room.regions[defKey].splice(index, 1);
      if (!room.regions[atkKey].includes(region)) {
        room.regions[atkKey].push(region);
        room.regionValues[region] = 400;
      }
    } 
    
    else if (winner === defender) {


      io.to(roomId).emit("battleDefended");

      const bonusKey = `Player${defender}`;
      room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;

      console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);



    }
    
    else {
      



    }

    // Aktualizace a konec
    await delay(2000);
    room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
    io.to(roomId).emit("updateRegions", {
      regions: room.regions,
      regionValues: room.regionValues,
      scores: room.scores
    });
    io.to(roomId).emit("updateScores", { scores: room.scores });
    return;
  }







  // 2. ZÁKLADNA
  let baseCaptured = false;

  while (!baseCaptured) {
    const correctPlayers = await runMultipleChoice(roomId, [attacker, defender]);
    

    // 2a. Vyhrál pouze útočník
    if (correctPlayers.length === 1 && correctPlayers[0] === attacker) {
      await delay(5100);
      room.playerLives[`Player${defender}`]--;
      io.to(roomId).emit("destroyTower", {
        defender,
        remainingLives: room.playerLives[`Player${defender}`]
      });
      await delay(6000);

      if (room.playerLives[`Player${defender}`] <= 0) {
        transferBase(roomId, room, attacker, defender, region);
        baseCaptured = true;
      }

      continue;
    }

    // 2b. Vyhrál pouze obránce
    if (correctPlayers.length === 1 && correctPlayers[0] === defender) {
      await delay(3000);
      io.to(roomId).emit("battleDefended");

      const bonusKey = `Player${defender}`;
      room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;

      console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);


      break;
    }

    // 2c/2d. Oba odpověděli správně → numeric
    if (correctPlayers.length > 1) {
      await delay(5100);
      const numericWinner = await runNumericQuestionForTwo(roomId, [attacker, defender]);
      await delay(3000);

      if (numericWinner === attacker) {
        await delay(4000);
        room.playerLives[`Player${defender}`]--;
        io.to(roomId).emit("destroyTower", {
          defender,
          remainingLives: room.playerLives[`Player${defender}`]
        });
        await delay(8000);

        if (room.playerLives[`Player${defender}`] <= 0) {
          transferBase(roomId, room, attacker, defender, region);
          baseCaptured = true;
        }

        continue;
      } else {
        io.to(roomId).emit("battleDefended");
        const bonusKey = `Player${defender}`;
        room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;

        console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);



        break;
      }
    }

    // 2e. Nikdo neodpověděl správně
    if (correctPlayers.length === 0) {
      await delay(3000);
      io.to(roomId).emit("battleDefended");
      break;
    }
  }

  if (isBase) {
    await delay(1500);
    io.to(roomId).emit("hideBaseMini");
  }

  // Final update
  room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
  io.to(roomId).emit("updateRegions", {
    regions: room.regions,
    regionValues: room.regionValues,
    scores: room.scores
  });
  io.to(roomId).emit("updateScores", { scores: room.scores });

  await delay(1000);
}




function checkForEliminatedPlayers(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  for (let player = 1; player <= 3; player++) {
    const playerRegions = room.regions[`Player${player}regions`] || [];

    if (playerRegions.length === 0) {
      console.log(`🛑 Hráč ${player} přišel o všechna území!`);
      io.to(roomId).emit("playerLoses", { defender: player });
    }
  }
}


function transferBase(roomId, room, attacker, defender, baseRegion) {
  const defKey = `Player${defender}regions`;
  const atkKey = `Player${attacker}regions`;

  const defenderRegions = room.regions[defKey] || [];

  defenderRegions.forEach(region => {
    if (!room.regions[atkKey].includes(region)) {
      room.regions[atkKey].push(region);
    }

    // ✅ Pouze základně přepiš hodnotu na 400
    if (region === baseRegion) {
      room.regionValues[region] = 400;
    }
  });

  // ✅ Vymaž obráncova území
  room.regions[defKey] = [];

  
  // ✅ Vynuluj obráncovy bonusy
  room.defenseBonuses[`Player${defender}`] = 0;
  console.log(`🛡️ Obránci Player${defender} byly vynulovány defense bonusy.`);


  checkForEliminatedPlayers(roomId);
}

  








function isAnyoneWinning(room) {
  const totalRegions = Object.keys(room.regionValues).length;
  return (
    room.regions.Player1regions.length === totalRegions ||
    room.regions.Player2regions.length === totalRegions ||
    room.regions.Player3regions.length === totalRegions
  );
}






async function runPlayerTurns(roomId, round, order) {
  const room = rooms[roomId];
  if (!room) return;

  room.selections = {};
  room.lastSelections = {}; // ✅ Reset pro aktuální kolo

  for (const player of order) {
    io.to(roomId).emit("playerTurn", {
      player,
      round,
      timeLeft: 10
    });

    const playerSocketId = room.players[player - 1].id;
    io.to(playerSocketId).emit("availableRegions", {
      regions: getAvailableRegions(room, player)
    });

    console.log(`🎯 Hráč ${player} je na tahu (kolo ${round})`);

    const selectedRegion = await waitForPlayerSelection(roomId, player, 10000);

    room.selections[player] = selectedRegion;
    room.lastSelections[player] = selectedRegion; // ✅ Uložíme i pro pozdější vyhodnocení

    console.log(`✅ Hráč ${player} vybral: ${selectedRegion}`);

    io.to(roomId).emit("playerSelectedRegion", {
      player,
      region: selectedRegion
    });

    await delay(1000);
  }

  console.log(`📌 Výběry v kole ${round}:`, room.selections);
}











function getAvailableRegions(room, player) {
  const allRegions = Object.keys(room.regionValues);

  const occupied = [
    ...room.regions.Player1regions,
    ...room.regions.Player2regions,
    ...room.regions.Player3regions
  ];

  const claimed = Array.from(room.claimedRegionsThisRound || []);

  // Volná a neclaimnutá políčka
  const freeRegions = allRegions.filter(region => 
    !occupied.includes(region) && !claimed.includes(region)
  );

  const owned = room.regions[`Player${player}regions`] || [];

  if (owned.length === 0) return freeRegions;

  const adjacentFree = freeRegions.filter(region =>
    owned.some(ownedRegion => adjacencyInfo[ownedRegion]?.includes(region))
  );

  return adjacentFree.length > 0 ? adjacentFree : freeRegions;
}





function getAvailableRegionsConquest(room) {
  const allRegions = Object.keys(room.regionValues);

  const occupied = [
    ...room.regions.Player1regions,
    ...room.regions.Player2regions,
    ...room.regions.Player3regions
  ];

 

  // Vrátí všechna volná a neclaimnutá políčka
  return allRegions.filter(region => 
    !occupied.includes(region)
  );
}









function waitForPlayerSelection(roomId, player, timeout, forcedAvailableRegions = null) {
  return new Promise(resolve => {
    const room = rooms[roomId];
    if (!room) return resolve(null);

    room.pendingSelections = room.pendingSelections || {};

    let elapsed = 0;
    const interval = setInterval(() => {



      if (!isRoomAlive(roomId)) { // 🔴 NEW
        clearInterval(interval);
        return resolve(null);
      }



      if (room.pendingSelections[player]) {
        clearInterval(interval);
        const region = room.pendingSelections[player];
        delete room.pendingSelections[player];

        if (room.claimedRegionsThisRound) {
          room.claimedRegionsThisRound.add(region);
        }

        resolve(region);
      }

      elapsed += 100;
      if (elapsed >= timeout) {
        clearInterval(interval);

        // ✅ POUŽIJ jen forcedAvailableRegions, pokud existují
        const accessible = forcedAvailableRegions !== null
          ? forcedAvailableRegions
          : getAvailableRegions(room, player);

        const randomRegion =
          accessible.length > 0
            ? accessible[Math.floor(Math.random() * accessible.length)]
            : null;

        console.log(`⏳ Hráč ${player} nestihl → náhodně: ${randomRegion}`);

        if (randomRegion && room.claimedRegionsThisRound) {
          room.claimedRegionsThisRound.add(randomRegion);
        }

        resolve(randomRegion);
      }
    }, 100);
  });
}








io.on('connection', socket => {





  console.log(`✅ ${socket.id} connected`);


  socket.on("baseSettled", ({ playerNumber }) => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room) continue;
  
      const regionKey = `Player${playerNumber}regions`;
      const baseRegion = room.bases[playerNumber];
  
      room.regionValues[baseRegion] = 1000;
  
      // Přesvědč se, že základna je ve správném seznamu
      if (!room.regions[regionKey].includes(baseRegion)) {
        room.regions[regionKey].push(baseRegion);
      }
  
      // Aktualizuj skóre
      room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
  
      // Pošli aktualizaci
      io.to(roomId).emit("updateScores", { scores: room.scores });
      console.log(`✅ Hráč ${playerNumber} obsadil ${baseRegion} (1000 bodů)`);
      console.log("🧮 Nové skóre:", room.scores);
      console.log("🎯 Hodnoty regionů:", room.regionValues);
    }
  });




  // FRIENDS: host vytvoří místnost a rovnou se do ní přidá
socket.on("createRoom", ({ settings }) => {
  const name = (settings?.name || "Host").toString();
  const roomId = `room_${genRoomCode?.(6) || Date.now()}`;

  const room = makeEmptyRoom(roomId, 'friends'); // friends room
  room.settings = settings || {};

  socket.emit("roomReady", { room: roomId });

  socket.data = socket.data || {};
  socket.data.joinedRoom = roomId;
  socket.data.name = name;

  // 🔁 dřív: addPlayerOnce → teď:
  roomAddPlayerAndBroadcast(roomId, socket, name);
});



// FRIENDS: hosté (nebo host, pokud už má kód) se připojují do existující room
socket.on("joinRoom", ({ room, settings }) => {
  const name = (settings?.name || "").toString().trim() || "Host";
  const roomId = (room || "").toString().trim();

  if (!roomId) {
    socket.emit("roomError", { message: "Missing room id" });
    return;
  }

  if (!rooms[roomId]) {
    makeEmptyRoom(roomId, 'friends');   // <-- důležité
    rooms[roomId].settings = settings || {};
  }

  const current = rooms[roomId];
  if (current.players.length >= MAX_PLAYERS_PER_ROOM) {
    socket.emit("roomError", { message: "Room is full" });
    return;
  }

  socket.data = socket.data || {};
  socket.data.joinedRoom = roomId;
  socket.data.name = name;

  roomAddPlayerAndBroadcast(roomId, socket, name);
  console.log(`👥 joinRoom → ${roomId} by ${name}`);
});













  socket.on("submitName", name => {
    // ✅ už je socket v nějaké room (friends)? ignoruj random přihlášku
    if (socket.data?.joinedRoom) return;

    // ✅ vezmi první NEplnou room, která je opravdu random
    let roomId = Object.keys(rooms).find(id =>
      rooms[id].mode === 'random' && rooms[id].players.length < MAX_PLAYERS_PER_ROOM
    );

    // žádná random room? vytvoř novou
    if (!roomId) {
      roomId = `room_${Date.now()}`;
      makeEmptyRoom(roomId, 'random');
    }

    socket.data = socket.data || {};
    socket.data.joinedRoom = roomId;
    socket.data.name = name;

    roomAddPlayerAndBroadcast(roomId, socket, name);

    console.log(`🎮 ${name} joined ${roomId}`);
  });















   socket.on("disconnect", () => {
    const roomId = socket.data?.joinedRoom;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index === -1) return;

    const name = room.players[index].name;
    room.players.splice(index, 1);

    const allNames = {};
    room.players.forEach((p, i) => { allNames[i + 1] = p.name; });

    io.to(roomId).emit("updatePlayers", { allNames });
    io.to(roomId).emit("updateScores", { scores: room.scores });

    console.log(`❌ ${name} left ${roomId}`);

    if (room.players.length === 0) {
      // 🔴 NEW: nejdřív scénář zastav
      markRoomClosed(roomId);
      io.to(roomId).emit("roomClosed"); // volitelné pro klienty

      // 🔴 NEW: chvíli počkej, ať async části bezpečně vycouvají, pak teprve smaž
      setTimeout(() => {
        delete rooms[roomId];
        console.log(`🗑️ Room ${roomId} deleted`);
      }, 100); // 100 ms stačí – jen “oddech” pro promisy/intervaly
    }
  });





 socket.on("claimRegion", ({ round, region }) => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (!room) continue;

    const player = room.players.findIndex(p => p.id === socket.id) + 1;
    if (player) {
      room.pendingSelections = room.pendingSelections || {};
      room.pendingSelections[player] = region;
      console.log(`📩 Přijato: Hráč ${player} → ${region}`);
      break;
    }
  }


});



socket.on("chat:send", ({ roomId, text }) => {
    console.log("📩 chat:send received", { from: socket.id, roomId, text });

    const room = rooms[roomId];
    if (!room) {
      console.log("❌ room not found for chat:", roomId);
      return;
    }

    const clean = (typeof text === "string" ? text.trim() : "");
    if (!clean) {
      console.log("❌ empty/invalid text");
      return;
    }

    const ix = room.players.findIndex(p => p.id === socket.id);
    const name = ix !== -1 ? room.players[ix].name : "Neznámý hráč";

    const msg = { id: `${Date.now()}_${Math.random().toString(16).slice(2)}`, name, text: clean.slice(0,500), ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.shift();

    console.log(`💬 [${roomId}] ${name}: ${clean}`);
    io.to(roomId).emit("chat:new", msg);
  });







  socket.on("addValueToBase", ({ base, roomId }) => {
        if (!roomId || !base) return;

        // Inicializuj místnost, pokud ještě neexistuje
        if (!regionValuesByRoom[roomId]) {
            regionValuesByRoom[roomId] = {};
        }

        // Nastav hodnotu základny na 1000
        regionValuesByRoom[roomId][base] = 1000;

       
  });



socket.on("playerAnswered", ({ room: roomId, player, answerIndex }) => {
  const room = rooms[roomId];
  if (!room) return;

  room.answers = room.answers || {};

  // Ulož odpověď jen pokud ještě neodpověděl
  if (room.answers[player] === undefined) {
    room.answers[player] = answerIndex;
    console.log(`✏️ Hráč ${player} v ${roomId} odpověděl: ${answerIndex}`);
  }
});




socket.on("playerNumericAnswer", ({ room: roomId, player, answer }) => {
  const room = rooms[roomId];
  if (!room) return;

  room.numericAnswers = room.numericAnswers || {};
  const startTime = room.numericStartTime || Date.now(); // server uchovává začátek

  if (!room.numericAnswers[player]) {
    room.numericAnswers[player] = {
      num: answer,
      time: Date.now() - startTime
    };
    console.log(`✏️ Numerická odpověď: Hráč ${player} v ${roomId} → ${answer} (${room.numericAnswers[player].time}ms)`);
  }
});







});





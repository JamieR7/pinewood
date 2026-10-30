/**
 * PACK 130 GENEVA - PINEWOOD DERBY ENGINE (derby-engine.js)
 * Pure JS state & scheduling engine for 6 Dens, 6 Lanes, variable car counts.
 * Complete Audited & Patched Version
 */

const DENS = [
  { id: 'Lions', name: 'Lions', prefix: 'L', emoji: '🦁' },
  { id: 'Tigers', name: 'Tigers', prefix: 'T', emoji: '🐯' },
  { id: 'Wolves', name: 'Wolves', prefix: 'WO', emoji: '🐺' },
  { id: 'Bears', name: 'Bears', prefix: 'B', emoji: '🐻' },
  { id: 'Webelos', name: 'Webelos', prefix: 'WE', emoji: '🧭' },
  { id: 'AOLs', name: 'AOLs', prefix: 'A', emoji: '🏹' }
];

const STORAGE_KEY = 'PACK_130_DERBY_STATE_V1';

/**
 * Unbiased Fisher-Yates array shuffle
 */
function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class DerbyEngine {
  constructor() {
    this.state = this.loadState() || this.getInitialState();
  }

  getInitialState() {
    return {
      // "AVERAGE" = Lowest avg finish wins + Top 2 per semi + Wildcard race (Slide Deck)
      // "POINTS"  = 6-5-4-3-2-1 pts + Top 3 per semi advance (Manual Plan)
      rulesMode: 'AVERAGE',
      stage: 'CHECK_IN', // CHECK_IN | QUALIFYING | SEMIFINALS | WILDCARD | FINALS
      activeHeatId: null,
      cars: [],
      heats: []
    };
  }

  saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('Failed to load state from localStorage', e);
      return null;
    }
  }

  resetAll() {
    this.state = this.getInitialState();
    this.saveState();
  }

  // ==========================================
  // 1. CHECK-IN & DEMO ROSTER
  // ==========================================
  addCar(denId, cubName, carName) {
    const denObj = DENS.find(d => d.id === denId);
    if (!denObj) throw new Error('Invalid Den');

    const denCars = this.state.cars.filter(c => c.den === denId);

    // Prevent duplicate ID collisions if an earlier car was removed
    const maxNum = denCars.reduce((max, c) => {
      const num = parseInt(c.id.replace(denObj.prefix, ''), 10) || 0;
      return Math.max(max, num);
    }, 0);
    const nextNum = maxNum + 1;
    const carId = `${denObj.prefix}${nextNum}`;

    const newCar = {
      id: carId,
      den: denId,
      cubName: cubName.trim(),
      carName: carName.trim() || `Car ${carId}`,
      checkedIn: true
    };

    this.state.cars.push(newCar);
    this.saveState();
    return newCar;
  }

  removeCar(carId) {
    this.state.cars = this.state.cars.filter(c => c.id !== carId);
    this.saveState();
  }

  loadDemoRoster() {
    this.state = this.getInitialState();
    const sampleCounts = { Lions: 4, Tigers: 6, Wolves: 8, Bears: 5, Webelos: 7, AOLs: 3 };
    const sampleNames = ['Thunder', 'Swiss Miss', 'Jet d\'Eau', 'Red Arrow', 'Matterhorn', 'Fondue Express', 'Vortex', 'Falcon', 'Cobra'];
    
    DENS.forEach(den => {
      const count = sampleCounts[den.id];
      for (let i = 1; i <= count; i++) {
        this.addCar(
          den.id,
          `${den.id.slice(0, -1)} Cub ${i}`,
          `${sampleNames[(i - 1) % sampleNames.length]} ${i}`
        );
      }
    });
    this.saveState();
  }

  // ==========================================
  // 2. DETERMINISTIC 6-LANE HEAT GENERATOR
  // ==========================================
  generateGroupHeats(cars, stage, groupName, runsPerCar = 3) {
    const N = cars.length;
    if (N === 0) return [];

    // Case 1: 6 or fewer cars -> All cars run together in `runsPerCar` heats, shifting +1 lane each heat
    if (N <= 6) {
      const heats = [];
      for (let h = 0; h < runsPerCar; h++) {
        const lanes = [];
        for (let cIdx = 0; cIdx < N; cIdx++) {
          const laneNum = ((cIdx + h) % 6) + 1;
          lanes.push({ lane: laneNum, carId: cars[cIdx].id, finish: null });
        }
        lanes.sort((a, b) => a.lane - b.lane);
        heats.push({
          id: `${stage}_${groupName}_H${h + 1}_${Date.now().toString().slice(-3)}`,
          stage,
          group: groupName,
          heatNumber: h + 1,
          status: 'PENDING',
          lanes
        });
      }
      return heats;
    }

    // Case 2: More than 6 cars -> Distribute evenly across ceil((N * runsPerCar) / 6) heats
    const totalSlots = N * runsPerCar;
    const numHeats = Math.ceil(totalSlots / 6);

    const targetSizes = Array(numHeats).fill(Math.floor(totalSlots / numHeats));
    for (let i = 0; i < (totalSlots % numHeats); i++) {
      targetSizes[i]++;
    }

    // Fast randomized Latin-square greedy solver with retries using unbiased Fisher-Yates shuffle
    for (let attempt = 0; attempt < 400; attempt++) {
      const heatBuckets = Array.from({ length: numHeats }, () => []);
      const carUsedHeats = new Map(cars.map(c => [c.id, new Set()]));
      const carUsedLanes = new Map(cars.map(c => [c.id, new Set()]));
      let success = true;

      for (let run = 0; run < runsPerCar; run++) {
        const shuffledCars = shuffleArray(cars);
        for (const car of shuffledCars) {
          const candidateHeats = [];
          for (let h = 0; h < numHeats; h++) {
            if (
              heatBuckets[h].length < targetSizes[h] &&
              !carUsedHeats.get(car.id).has(h)
            ) {
              const takenLanesInHeat = new Set(heatBuckets[h].map(slot => slot.lane));
              const usedByCar = carUsedLanes.get(car.id);
              const availableLanes = [1, 2, 3, 4, 5, 6].filter(
                l => !takenLanesInHeat.has(l) && !usedByCar.has(l)
              );
              if (availableLanes.length > 0) {
                candidateHeats.push({ h, availableLanes });
              }
            }
          }

          if (candidateHeats.length === 0) {
            success = false;
            break;
          }

          candidateHeats.sort(
            (a, b) =>
              (targetSizes[b.h] - heatBuckets[b.h].length) -
              (targetSizes[a.h] - heatBuckets[a.h].length)
          );

          const chosen = candidateHeats[0];
          const chosenLane =
            chosen.availableLanes[Math.floor(Math.random() * chosen.availableLanes.length)];

          heatBuckets[chosen.h].push({ lane: chosenLane, carId: car.id, finish: null });
          carUsedHeats.get(car.id).add(chosen.h);
          carUsedLanes.get(car.id).add(chosenLane);
        }
        if (!success) break;
      }

      if (success) {
        return heatBuckets.map((lanes, idx) => ({
          id: `${stage}_${groupName}_H${idx + 1}`,
          stage,
          group: groupName,
          heatNumber: idx + 1,
          status: 'PENDING',
          lanes: lanes.sort((a, b) => a.lane - b.lane)
        }));
      }
    }

    // Fallback cyclic assignment if strict lane constraint needs relaxation
    const fallbackBuckets = Array.from({ length: numHeats }, () => []);
    let heatCursor = 0;
    for (let r = 0; r < runsPerCar; r++) {
      for (const car of cars) {
        while (
          fallbackBuckets[heatCursor].length >= 6 ||
          fallbackBuckets[heatCursor].some(s => s.carId === car.id)
        ) {
          heatCursor = (heatCursor + 1) % numHeats;
        }
        const usedLanes = new Set(fallbackBuckets[heatCursor].map(s => s.lane));
        const lane = [1, 2, 3, 4, 5, 6].find(l => !usedLanes.has(l)) || 1;
        fallbackBuckets[heatCursor].push({ lane, carId: car.id, finish: null });
        heatCursor = (heatCursor + 1) % numHeats;
      }
    }

    return fallbackBuckets.map((lanes, idx) => ({
      id: `${stage}_${groupName}_H${idx + 1}`,
      stage,
      group: groupName,
      heatNumber: idx + 1,
      status: 'PENDING',
      lanes: lanes.sort((a, b) => a.lane - b.lane)
    }));
  }

  // ==========================================
  // 3. STAGE TRANSITIONS & SCORING
  // ==========================================
  startQualifying() {
    this.state.heats = [];
    DENS.forEach(den => {
      const denCars = this.state.cars.filter(c => c.den === den.id && c.checkedIn);
      if (denCars.length >= 2) {
        const denHeats = this.generateGroupHeats(denCars, 'QUALIFYING', den.id, 3);
        this.state.heats.push(...denHeats);
      }
    });
    this.state.stage = 'QUALIFYING';
    this.state.activeHeatId = this.state.heats[0]?.id || null;
    this.saveState();
  }

  recordHeatResult(heatId, laneFinishesMap) {
    const heat = this.state.heats.find(h => h.id === heatId);
    if (!heat) return;

    heat.lanes.forEach(slot => {
      slot.finish = laneFinishesMap[slot.lane] || null;
    });
    heat.status = 'COMPLETED';

    const nextPending = this.state.heats.find(h => h.status === 'PENDING');
    this.state.activeHeatId = nextPending ? nextPending.id : heat.id;
    this.saveState();
  }

  rerunHeat(heatId) {
    const heat = this.state.heats.find(h => h.id === heatId);
    if (!heat) return;
    heat.lanes.forEach(slot => { slot.finish = null; });
    heat.status = 'PENDING';
    this.state.activeHeatId = heat.id;
    this.saveState();
  }

  getGroupStandings(stage, groupName) {
    const relevantHeats = this.state.heats.filter(
      h => h.stage === stage && h.group === groupName && h.status === 'COMPLETED'
    );

    const allStageHeats = this.state.heats.filter(
      h => h.stage === stage && h.group === groupName
    );
    const carIds = new Set();
    allStageHeats.forEach(h => h.lanes.forEach(l => carIds.add(l.carId)));

    const stats = Array.from(carIds).map(carId => {
      const car = this.state.cars.find(c => c.id === carId);
      let racesCompleted = 0;
      let finishSum = 0;
      let pointsSum = 0;
      let tieBreakerRank = null;

      relevantHeats.forEach(h => {
        const slot = h.lanes.find(l => l.carId === carId);
        if (slot && slot.finish !== null) {
          if (h.isTieBreaker) {
            tieBreakerRank = slot.finish;
          } else {
            racesCompleted++;
            finishSum += slot.finish;
            pointsSum += Math.max(1, 7 - slot.finish);
          }
        }
      });

      const exactAvg = racesCompleted > 0 ? finishSum / racesCompleted : 999;

      return {
        carId,
        carName: car?.carName || carId,
        cubName: car?.cubName || '',
        den: car?.den || '',
        racesCompleted,
        finishSum,
        pointsSum,
        exactAvg,
        avgFinish: Number(exactAvg.toFixed(2)),
        tieBreakerRank
      };
    });

    // Sort by rulesMode using exact precision before tie-breakers
    stats.sort((a, b) => {
      if (a.racesCompleted === 0 && b.racesCompleted === 0) return 0;
      if (a.racesCompleted === 0) return 1;
      if (b.racesCompleted === 0) return -1;

      if (this.state.rulesMode === 'AVERAGE') {
        // Exact cross-multiplication prevents floating-point rounding false ties
        const diff = (a.finishSum * b.racesCompleted) - (b.finishSum * a.racesCompleted);
        if (diff !== 0) return diff;
      } else {
        if (b.pointsSum !== a.pointsSum) return b.pointsSum - a.pointsSum;
      }

      if (a.tieBreakerRank !== null && b.tieBreakerRank !== null) {
        return a.tieBreakerRank - b.tieBreakerRank;
      }
      return 0;
    });

    return stats;
  }

  spawnTieBreakerHeat(stage, groupName, carIds) {
    const lanes = carIds.slice(0, 6).map((carId, idx) => ({
      lane: idx + 1,
      carId,
      finish: null
    }));

    const tbHeat = {
      id: `${stage}_${groupName}_TB_${Date.now().toString().slice(-3)}`,
      stage,
      group: groupName,
      heatNumber: 'TIE-BREAKER',
      isTieBreaker: true,
      status: 'PENDING',
      lanes
    };

    this.state.heats.push(tbHeat);
    this.state.activeHeatId = tbHeat.id;
    this.saveState();
    return tbHeat;
  }

  startSemifinals() {
    // Idempotency guard: clear any existing Semifinal, Wildcard, or Final heats if re-triggered
    this.state.heats = this.state.heats.filter(
      h => h.stage === 'QUALIFYING'
    );

    const groupACars = [];
    const groupBCars = [];

    DENS.forEach((den, idx) => {
      const standings = this.getGroupStandings('QUALIFYING', den.id);
      const first = standings[0];
      const second = standings[1];

      if (first) {
        const carObj = this.state.cars.find(c => c.id === first.carId);
        if (idx % 2 === 0) groupACars.push(carObj);
        else groupBCars.push(carObj);
      }
      if (second) {
        const carObj = this.state.cars.find(c => c.id === second.carId);
        if (idx % 2 === 0) groupBCars.push(carObj);
        else groupACars.push(carObj);
      }
    });

    const semiRuns = this.state.rulesMode === 'AVERAGE' ? 3 : 2;
    const semiAHeats = this.generateGroupHeats(groupACars, 'SEMIFINALS', 'Semifinal A', semiRuns);
    const semiBHeats = this.generateGroupHeats(groupBCars, 'SEMIFINALS', 'Semifinal B', semiRuns);

    this.state.heats.push(...semiAHeats, ...semiBHeats);
    this.state.stage = 'SEMIFINALS';
    this.state.activeHeatId = semiAHeats[0]?.id || null;
    this.saveState();
  }

  startWildcardRace() {
    // Idempotency guard: clear any prior Wildcard or Final heats if re-triggered
    this.state.heats = this.state.heats.filter(
      h => h.stage === 'QUALIFYING' || h.stage === 'SEMIFINALS'
    );

    const semiA = this.getGroupStandings('SEMIFINALS', 'Semifinal A');
    const semiB = this.getGroupStandings('SEMIFINALS', 'Semifinal B');

    const wildcardPoolIds = [
      semiA[2]?.carId, semiA[3]?.carId, semiA[4]?.carId,
      semiB[2]?.carId, semiB[3]?.carId, semiB[4]?.carId
    ].filter(Boolean).slice(0, 6);

    const wildcardCars = wildcardPoolIds.map(id => this.state.cars.find(c => c.id === id));
    const wcHeats = this.generateGroupHeats(wildcardCars, 'WILDCARD', 'Wildcard Race', 1);

    this.state.heats.push(...wcHeats);
    this.state.stage = 'WILDCARD';
    this.state.activeHeatId = wcHeats[0]?.id || null;
    this.saveState();
  }

  startGrandFinal() {
    // Idempotency guard: remove any existing FINALS heats if re-triggered
    this.state.heats = this.state.heats.filter(
      h => h.stage !== 'FINALS'
    );

    const semiA = this.getGroupStandings('SEMIFINALS', 'Semifinal A');
    const semiB = this.getGroupStandings('SEMIFINALS', 'Semifinal B');
    let finalistIds = [];

    const wcStandings = this.getGroupStandings('WILDCARD', 'Wildcard Race');
    if (wcStandings.length > 0) {
      finalistIds = [
        semiA[0]?.carId, semiA[1]?.carId,
        semiB[0]?.carId, semiB[1]?.carId,
        wcStandings[0]?.carId, wcStandings[1]?.carId
      ].filter(Boolean);
    } else {
      finalistIds = [
        semiA[0]?.carId, semiA[1]?.carId, semiA[2]?.carId,
        semiB[0]?.carId, semiB[1]?.carId, semiB[2]?.carId
      ].filter(Boolean);
    }

    const finalCars = finalistIds.map(id => this.state.cars.find(c => c.id === id));
    const finalRuns = this.state.rulesMode === 'AVERAGE' ? 2 : 3;
    const finalHeats = this.generateGroupHeats(finalCars, 'FINALS', 'Grand Final', finalRuns);

    this.state.heats.push(...finalHeats);
    this.state.stage = 'FINALS';
    this.state.activeHeatId = finalHeats[0]?.id || null;
    this.saveState();
  }
}

// Expose globally for index.html
window.DENS = DENS;
window.DerbyEngine = DerbyEngine;

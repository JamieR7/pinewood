/**
 * PACK 130 GENEVA - PINEWOOD DERBY ENGINE (derby-engine.js)
 * Pure JS state & scheduling engine for 6 Dens, 6 Lanes, variable car counts.
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
    const nextNum = denCars.length + 1;
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
    // Deliberately varied car counts per den (4, 6, 8, 5, 7, 3) to test <6, =6, and >6 math
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
  /**
   * Generates heats for a group of cars so every car races `runsPerCar` times (default 3)
   * across up to 6 lanes without repeating a lane in its runs or racing twice in the same heat.
   */
  generateGroupHeats(cars, stage, groupName, runsPerCar = 3) {
    const N = cars.length;
    if (N === 0) return [];

    // Case 1: 6 or fewer cars -> All cars run together in `runsPerCar` heats, shifting lanes
    if (N <= 6) {
      const heats = [];
      for (let h = 0; h < runsPerCar; h++) {
        const lanes = [];
        for (let cIdx = 0; cIdx < N; cIdx++) {
          // Shift lane each heat so no car repeats a lane (1 to 6)
          const laneNum = ((cIdx + h * 2) % 6) + 1;
          lanes.push({ lane: laneNum, carId: cars[cIdx].id, finish: null });
        }
        // If collision occurred on even shift (doesn't happen with +1), fallback to +1 shift
        const uniqueLanes = new Set(lanes.map(l => l.lane));
        if (uniqueLanes.size < N) {
          lanes.forEach((l, idx) => { l.lane = ((idx + h) % 6) + 1; });
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

    // Target sizes for each heat (e.g., 21 slots across 4 heats -> [6, 5, 5, 5])
    const targetSizes = Array(numHeats).fill(Math.floor(totalSlots / numHeats));
    for (let i = 0; i < (totalSlots % numHeats); i++) {
      targetSizes[i]++;
    }

    // Fast randomized Latin-square greedy solver with retries
    for (let attempt = 0; attempt < 400; attempt++) {
      const heatBuckets = Array.from({ length: numHeats }, () => []);
      const carUsedHeats = new Map(cars.map(c => [c.id, new Set()]));
      const carUsedLanes = new Map(cars.map(c => [c.id, new Set()]));
      let success = true;

      for (let run = 0; run < runsPerCar; run++) {
        const shuffledCars = [...cars].sort(() => Math.random() - 0.5);
        for (const car of shuffledCars) {
          // Find heats that have space and don't contain this car yet
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

          // Pick heat with most remaining capacity to keep heats balanced
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
    // laneFinishesMap: { [laneNumber]: finishPosition (1..6) }
    const heat = this.state.heats.find(h => h.id === heatId);
    if (!heat) return;

    heat.lanes.forEach(slot => {
      slot.finish = laneFinishesMap[slot.lane] || null;
    });
    heat.status = 'COMPLETED';

    // Auto-advance activeHeatId to next PENDING heat
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

  /**
   * Computes standings for any stage & group (e.g., stage="QUALIFYING", group="Wolves")
   */
  getGroupStandings(stage, groupName) {
    const relevantHeats = this.state.heats.filter(
      h => h.stage === stage && h.group === groupName && h.status === 'COMPLETED'
    );

    // Find all cars participating in this stage/group
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
            pointsSum += Math.max(1, 7 - slot.finish); // 1st=6, 2nd=5 ... 6th=1
          }
        }
      });

      const avgFinish = racesCompleted > 0 ? finishSum / racesCompleted : 999;

      return {
        carId,
        carName: car?.carName || carId,
        cubName: car?.cubName || '',
        den: car?.den || '',
        racesCompleted,
        finishSum,
        pointsSum,
        avgFinish: Number(avgFinish.toFixed(2)),
        tieBreakerRank
      };
    });

    // Sort by rulesMode, using tieBreakerRank if a race-off was completed
    stats.sort((a, b) => {
      if (a.racesCompleted === 0 && b.racesCompleted === 0) return 0;
      if (a.racesCompleted === 0) return 1;
      if (b.racesCompleted === 0) return -1;

      if (this.state.rulesMode === 'AVERAGE') {
        if (a.avgFinish !== b.avgFinish) return a.avgFinish - b.avgFinish;
      } else {
        if (b.pointsSum !== a.pointsSum) return b.pointsSum - a.pointsSum;
      }

      // If tied on primary metric, check head-to-head tie-breaker heat
      if (a.tieBreakerRank !== null && b.tieBreakerRank !== null) {
        return a.tieBreakerRank - b.tieBreakerRank;
      }
      return 0;
    });

    return stats;
  }

  /**
   * Spawns a 1-off tie-breaker race between tied cars in a group
   */
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

  /**
   * Advances Top 2 from each Den into Semifinal Group A and Semifinal Group B
   * Splits same-den qualifiers so Den #1 goes to A, Den #2 goes to B (alternating)
   */
  startSemifinals() {
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

    // Slide Deck uses 3 heats per semifinal; Manual Plan uses 2 heats per semifinal
    const semiRuns = this.state.rulesMode === 'AVERAGE' ? 3 : 2;
    const semiAHeats = this.generateGroupHeats(groupACars, 'SEMIFINALS', 'Semifinal A', semiRuns);
    const semiBHeats = this.generateGroupHeats(groupBCars, 'SEMIFINALS', 'Semifinal B', semiRuns);

    this.state.heats.push(...semiAHeats, ...semiBHeats);
    this.state.stage = 'SEMIFINALS';
    this.state.activeHeatId = semiAHeats[0]?.id || null;
    this.saveState();
  }

  /**
   * Optional Wildcard One-Off Race (Slide Deck rules: 3rd & 4th place from Semis A & B race for final 2 spots)
   */
  startWildcardRace() {
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

  /**
   * Advances 6 finalists to the Grand Final
   */
  startGrandFinal() {
    const semiA = this.getGroupStandings('SEMIFINALS', 'Semifinal A');
    const semiB = this.getGroupStandings('SEMIFINALS', 'Semifinal B');
    let finalistIds = [];

    const wcStandings = this.getGroupStandings('WILDCARD', 'Wildcard Race');
    if (wcStandings.length > 0) {
      // Top 2 from Semi A + Top 2 from Semi B + Top 2 from Wildcard
      finalistIds = [
        semiA[0]?.carId, semiA[1]?.carId,
        semiB[0]?.carId, semiB[1]?.carId,
        wcStandings[0]?.carId, wcStandings[1]?.carId
      ].filter(Boolean);
    } else {
      // Top 3 from Semi A + Top 3 from Semi B
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

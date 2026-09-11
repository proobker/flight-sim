# SkyMesh — Implementation Log

## v0.2.0 (v2) — Frontend 3D Visualization (React + TypeScript + Three.js)

### Date: September 11 2026

### Summary

Added the browser frontend: a Three.js 3D airspace view fed by the backend WebSocket, with a live dashboard and a failure-injection control panel. Build verified, screenshot-captured against a live backend (aircraft + conflict markers confirmed rendering).

### What was built

- **`frontend/`** — Vite + React 18 + TypeScript + Three.js project.

- **`src/api/types.ts`** — TypeScript types mirroring the backend snapshot schema (`SimSnapshot`, `AircraftSnapshot`, `Obstacle`, `NeighborInfo`, …).

- **`src/hooks/useSimulationSocket.ts`** — WebSocket client for `/ws` with auto-reconnect (1.5s retry) and a connected status flag.

- **`src/visualization/SkyScene.ts`** — Core Three.js engine:
  - Aircraft rendered as cone markers colored by priority (normal=cyan, cargo=orange, passenger=green, medical=yellow, emergency=red), rotated along heading, with pulsing red emissive for emergency aircraft.
  - Dashed predicted-velocity vector per aircraft (15 s projection, capped 2.5 km).
  - Faint destination lines and 30-point position trails.
  - Red conflict lines connecting aircraft pairs currently in conflict (`conflict_with`).
  - Communication links: translucent cyan lines to active neighbors, amber for stale neighbors.
  - Obstacles (no-fly/storm/airport) as translucent cylinders.
  - Uncertainty regions: translucent red spheres that grow with neighbor `age` for stale/unresponsive peers.
  - Grid floor + airspace bounds wireframe; OrbitControls camera; fog for depth.

- **`src/components/Dashboard.tsx`** — Live metrics overlay: aircraft count, active conflicts, resolved/detected, collisions, near misses, min separation (km), avg resolution (ms), nodes failed, partitions, sim time.

- **`src/components/ControlPanel.tsx`** — Failure-injection panel calling the REST API:
  - Kill 5 / 20 random aircraft, spawn emergency
  - Partition / rejoin network
  - Packet-loss slider (0–100%), latency input (0–5000 ms)
  - Create storm, add no-fly zone, close airport, spawn N aircraft

- **`src/App.tsx`**, **`vite.config.ts`** — Dev proxy forwards `/api` and `/ws` to the backend on port 8000; connection status badge (● LIVE / ○ RECONNECTING).

### Verification

- `npm run build` passes (tsc strict + vite build).
- Live E2E via headless Edge against a running backend: HTTP 200, WS proxy delivers snapshots, screenshot analysis confirmed ~2.4k cyan aircraft pixels and ~1k red emergency/conflict pixels rendered in the 3D scene.

### Notes

- Coordinates map sim `(x, y, z_alt)` → three `(x, z_alt, y)` so altitude is the vertical axis.
- Screenshot saved to `docs/screenshot.png`.

---

## v0.1.0 (v1) — Simulation Core + Backend + REST API + WebSocket

### Date: September 11 2026

### Summary

Complete backend simulator with real UDP P2P networking, 4D conflict detection, distributed negotiation, failure injection, REST control API, and WebSocket live stream. Unit tests pass. All failure modes functional.

### What was built

#### Simulation Core (`backend/simulation/`)

- **`aircraft.py`** — `Aircraft` class: position, velocity, heading, destination, speed, priority, emergency flag. `Plan` dataclass holds committed velocity + duration. Movement model: steer toward destination with turn rate + climb toward cruise altitude; when executing a committed maneuver plan, fly the plan's fixed velocity for its duration. `commit_plan()`, `propose()`, `accept_pending()`, `reject_pending()` manage trajectory state.

- **`physics.py`** — Pure geometry/movement helpers: `advance()`, `distance()`, `h_distance()`, `v_distance()`, `to_velocity()`, `heading_to()`, `closest_approach()` (analytic 3D closest approach in [0, horizon]), `points_along()`. All coordinates are (x, y, z) meters.

- **`airspace.py`** — `Airspace` class with configurable bounds (width, depth, floor, ceiling). `Obstacle` dataclass (NO_FLY, STORM, AIRPORT) with cylindrical containment test. `obstacles_between()` segment-vs-cylinder intersection for route planning. `random_point()`, `enforce_bounds()`.

- **`conflict.py`** — `ConflictDetector`: given two positions+velocities, analytic closest approach in 3D over a horizon; returns `Conflict(t, distance, predicted_point)`. Also `detect_against_uncertainty()` for silent peers with growing uncertainty region.

- **`maneuver.py`** — `generate_candidates()` samples 11 discrete maneuvers (turn ±10°/±18°, climb, descend, slow, fast, climb_left, climb_right, straight). `filter_candidates()` checks each candidate against neighbors, uncertain peers, obstacles and bounds; discards unsafe candidates.

- **`cost.py`** — `plan_cost()` / `candidate_cost()`: cost = heading deviation × weight × emergency_factor + complexity + risk + delay ordering. Emergency aircraft pay a fraction (×0.4) of deviation cost.

- **`negotiation.py`** — `decide_winner()` deterministic rule: priority → cost → trajectory version → aircraft ID. `proposal_consensus_response()` computes accept/reject response to an incoming proposal considering my pending proposal.

- **`uncertainty.py`** — `uncertain_radius(age)` and `uncertain_altitude(age)` linear growth models, capped. `SilentRegion` dataclass wraps a silent peer's last known position + age with properties for `uncertain_radius` and `altitude_envelope`.

#### Networking (`backend/network/`)

- **`protocol.py`** — Message types: HELLO, STATE_UPDATE, HEARTBEAT, CONFLICT_ALERT, TRAJECTORY_PROPOSAL, TRAJECTORY_ACCEPT, TRAJECTORY_REJECT, TRAJECTORY_COMMIT, EMERGENCY. `state_update()` factory, `encode()`/`decode()` JSON helpers.

- **`udp_node.py`** — `UdpNode` class: one UDP socket per aircraft, joining multicast group `239.255.42.99:42099`. Socket uses `SO_REUSEADDR`. Reader task drains incoming datagrams into a `collections.deque`. `send()` injects packet loss, latency, jitter before `sendto`. `block_partition()`/`unblock_partition()` for network partition simulation.

- **`neighbor.py`** — `NeighborTable` with `NeighborEntry` per known aircraft: position, velocity, heading, priority, trajectory_version, plan, confidence, last_seen age. States: ACTIVE → STALE → UNRESPONSIVE based on timeout thresholds. `upsert()` from incoming messages. `as_dict()` with distance from observer.

#### Engine (`backend/engine/`)

- **`agent.py`** — `AircraftAgent`: the per-aircraft brain. `step(dt)` (synchronous): drains UDP inbox → applies messages → advances position → broadcasts state (every N ticks) → detects conflicts (every M ticks) → generates/filters/costs candidates → sends TRAJECTORY_PROPOSAL → handles PROPOSAL/ACCEPT/REJECT from peers. Deterministic responsibility: for a conflict pair, the aircraft with higher priority (or lower ID) is responsible for proposing. Negotiation deduplication via `active_conflicts` dict with time-based expiry.

- **`simulator.py`** — `Simulator` class: spawns N `AircraftAgent` + `UdpNode` pairs. Main async tick loop at configurable rate. Failure injection methods: `kill_aircraft()`, `kill_random()`, `partition_network()`, `rejoin_network()`, `set_packet_loss()`, `set_latency()`, `spawn_emergency()`, `add_storm()`, `add_nofly()`, `close_airport()`. Central `_collect_metrics()`: O(n²) nearest-separation, collision, near-miss tracking. `snapshot()` returns full state for API/WS.

- **`metrics.py`** — `Metrics`: conflict_count, resolved_count, min_separation, near_misses, collisions, avg_resolution_ms, nodes_failed, partition_events. `ConflictRecord` dataclass tracks individual conflict timing.

#### API (`backend/api/`)

- **`main.py`** — FastAPI app with CORS. REST endpoints for all controls. WebSocket `/ws` endpoint with background broadcast task pushing snapshot JSON at ~10 Hz. `init_simulator()` / `shutdown_simulator()` lifecycle hooks.

- **`run.py`** — CLI entry point: `python -m backend.run --serve` (FastAPI) or `--aircraft N --seconds T` (headless print metrics).

#### Tests (`backend/tests/`)

- **`test_core.py`** — 12 tests covering: closest_approach (real crossing, parallel), conflict detector (catches crossing, time-separated, vertical separation), uncertainty growth, decision winners (cost, priority, ID tiebreak), proposal consensus, aircraft movement, maneuver commit.

### Performance Results

| Scenario | Aircraft | Tick Rate | Real-time Factor | Notes |
|----------|----------|-----------|-----------------|-------|
| Headless (12Hz) | 60 | 12Hz | ~1.0× | Smooth, <50ms/tick |
| Headless (12Hz) | 120 | 12Hz | ~0.3× | Multicast fan-out dominant |
| Server (12Hz) | 60 | 12Hz | ~0.8× | + API/WS overhead |

**Key bottleneck:** Windows multicast fan-out scales with local receiver count (~4ms sendto at 120 receivers). For 60+ aircraft, detection cadence (every 3 ticks) and broadcast cadence (every 6 ticks) keep the tick budget manageable.

### UDP Multicast Discovery

Tested `SO_REUSEADDR` multicast on Windows 11 + Python 3.14: confirmed multiple local sockets on the same multicast group reliably receive all datagrams. Group `239.255.42.99:42099`.

### Conflict Detection Tuning

- Default `comm_range = 6000m` → each aircraft receives ~30-60 neighbors in a 60-aircraft airspace
- `detect_every = 3` ticks → conflict detection runs at ~4Hz (sufficient for 50-100 m/s aircraft)
- `broadcast_every = 6` ticks → state broadcast at ~2Hz (stale timeout = 2s → 5 broadcasts per timeout)
- `max_proposal_rounds = 2` → limits negotiation ping-pong, forces deterministic commit

### Known Limitations (v0.1.0)

1. **No 3D visualization** — frontend not yet built
2. **No obstacle re-routing** — storm/NO_FLY detected but no path planner avoids them
3. **Negotiation is best-effort** — message loss can cause missed proposals, mitigated by forced commit after max rounds
4. **Metrics resolution is approximate** — conflicts tracked per-pair per-timer, may flicker
5. **No trajectory replanning** — aircraft steer toward destination, no A*/RRT planner

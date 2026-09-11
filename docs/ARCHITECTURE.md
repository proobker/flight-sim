# SkyMesh — Architecture

## System Overview

```
                    ┌──────────────────────┐
                    │   Simulation Engine  │  ← async tick loop
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        Physics Engine     Network Engine    Event Engine
              │                │                │
              └────────────────┼────────────────┘
                               ▼
                     ┌──────────────────┐
                     │ Aircraft Agents  │  ← P2P UDP peers
                     └────────┬─────────┘
                              │
          ┌───────────────────┼────────────────────┐
          ↓                   ↓                    ↓
      Agent A             Agent B              Agent C
          ↕                   ↕                    ↕
      Local state          Local state          Local state
      4D conflict          4D conflict          4D conflict
      Distributed          Distributed          Distributed
      negotiate            negotiate            negotiate
          ↕                   ↕                    ↕
      Trajectory           Trajectory           Trajectory
      planner              planner              planner
```

## Aircraft Agent Loop

Each `AircraftAgent` runs a synchronous `step(dt)` every tick:

```
RECEIVE MESSAGES (drain UDP inbox)
         ↓
UPDATE NEIGHBOR TABLE (by comm_range)
         ↓
ADVANCE POSITION (steer toward destination or execute committed plan)
         ↓
BROADCAST STATE (every N ticks via UDP multicast)
         ↓
DETECT CONFLICTS (every M ticks, against live + uncertain neighbors)
         ↓
  ┌──────┴──────┐
  │ CONFLICT?   │
  ├── NO → done │
  └── YES ──────┤
               ↓
  GENERATE CANDIDATE MANEUVERS (11 options)
         ↓
  FILTER UNSAFE (against neighbors, obstacles, bounds)
         ↓
  COST & RANK (lowest cost wins)
         ↓
  DETERMINE RESPONSIBILITY (priority then ID)
         ↓
  SEND TRAJECTORY_PROPOSAL (via UDP to other aircraft)
         ↓
  HANDLE INCOMING PROPOSAL (deterministic accept/reject)
         ↓
  COMMIT WINNER TRAJECTORY (broadcast TRAJECTORY_COMMIT)
```

## UDP Multicast Network

All aircraft join a single local multicast group:
- Group: `239.255.42.99`
- Port: `42099`

Every datagram is broadcast to all local receivers. Each agent filters by:
1. Sender ID != self
2. Sender partition not in blocked set
3. Sender distance < comm_range (for neighbor table)

### Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `STATE_UPDATE` | broadcast | periodic position/velocity/plan |
| `HELLO` | broadcast | announce on join |
| `TRAJECTORY_PROPOSAL` | unicast (to target) | propose maneuver to peer |
| `TRAJECTORY_ACCEPT` | unicast | accept peer's proposal |
| `TRAJECTORY_REJECT` | unicast | reject with reason |
| `TRAJECTORY_COMMIT` | broadcast | commit to new trajectory |

## Failure Injection Architecture

Failures are injected at two levels:

**Network layer** (per-UdpNode):
- `loss` — probability of dropping outbound datagram
- `latency_ms` — artificial one-way delay
- `jitter_ms` — random added delay
- `blocked_partitions` — set of partition IDs to ignore

**Application layer** (per-Simulator):
- `aircraft.active = False` — stops UDP, movement, conflict detection
- Neighbor table stale/hard timeout → ACTIVE → STALE → UNRESPONSIVE
- Uncertainty region grows linearly: `base + growth × silence_age`

## Deterministic Conflict Resolution

For any conflict pair (A, B), both run the same algorithm independently:

```
PRIORITY: higher priority wins
COST:     lower maneuver cost wins
VERSION:  higher trajectory version wins
ID:       lexicographically smaller ID wins
```

This guarantees both sides converge on the same winner without additional messages.

## Metrics Pipeline

Central `Metrics` object records:
- Per-conflict: `ConflictRecord` with detection + resolution timestamps
- Aggregate: collision count, near misses, min separation, nodes failed

`snapshot()` aggregates into JSON for the WebSocket/API clients.

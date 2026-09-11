# SkyMesh — API Reference

## REST Endpoints

Base URL: `http://127.0.0.1:8000`

### `GET /`
Service metadata.

```json
{
  "name": "SkyMesh",
  "version": "0.1.0",
  "status": "running"
}
```

### `GET /api/state`
Full simulation snapshot.

```json
{
  "time": 12.75,
  "aircraft_count": 55,
  "active": 55,
  "network_nodes_total": 60,
  "active_conflicts": 3,
  "collisions": 0,
  "near_misses": 9,
  "min_separation": 429.9,
  "conflicts_detected": 127,
  "conflicts_resolved": 64,
  "avg_resolution_ms": 842.1,
  "nodes_failed": 5,
  "partition_events": 1,
  "aircraft": [ ... ],
  "airspace": { ... }
}
```

### `POST /api/control/kill_random`
Body: `{"count": 5}` — randomly kill N aircraft.

### `POST /api/control/kill`
Body: `{"id": "A001"}` — kill specific aircraft, remove from UDP.

### `POST /api/control/spawn_emergency`
Spawns a 4th-priority emergency aircraft `E###`. Returns `{"id": "E001"}`.

### `POST /api/control/partition`
Splits the network into two partitions along the x-midline. Aircraft east/west cannot hear each other.

### `POST /api/control/rejoin`
Restores full connectivity between partitions.

### `POST /api/control/packet_loss`
Body: `{"value": 0.3}` — set drop probability (0.0–1.0) on all nodes.

### `POST /api/control/latency`
Body: `{"ms": 200}` — set artificial one-way latency on all nodes.

### `POST /api/control/storm`
Adds a random storm obstacle.

### `POST /api/control/close_airport`
Adds a random airport closure obstacle.

### `POST /api/control/add_nofly`
Adds a random no-fly zone.

### `POST /api/control/traffic`
Body: `{"count": 10}` — spawn N additional aircraft.

## WebSocket

### `WS /ws`
Opens a real-time stream. The server pushes a full snapshot JSON approximately every 100ms.

## UDP Protocol

All datagrams are JSON-encoded UTF-8, written to the multicast group `239.255.42.99:42099`.

### Common Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | one of the message types below |
| `sender` | string | aircraft ID (e.g., `A001`) |
| `_partition` | string | sender's partition ID (used for partition filtering) |
| `sim_time` | float | simulation time at send |

### `STATE_UPDATE`

```json
{
  "type": "STATE_UPDATE",
  "sender": "A017",
  "sim_time": 18234.42,
  "position": [1020.5, 2300.1, 500.0],
  "velocity": [150.0, 30.0, 0.0],
  "heading": 1.87,
  "speed": 152.9,
  "vertical_rate": 0.0,
  "destination": [12000.0, 9000.0, 1500.0],
  "priority": 1,
  "emergency": false,
  "trajectory_version": 42,
  "plan": [[150.0, 30.0, 0.0], 3.0]
}
```

### `TRAJECTORY_PROPOSAL`

```json
{
  "type": "TRAJECTORY_PROPOSAL",
  "sender": "A017",
  "target": "B004",
  "proposal_id": "A017-43-882",
  "proposal_version": 43,
  "maneuver": { "velocity": [145.0, 35.0, 0.0], "duration": 3.0 },
  "cost": 17.3,
  "priority": 1,
  "time_to_conflict": 8.2
}
```

### `TRAJECTORY_ACCEPT`

```json
{ "type": "TRAJECTORY_ACCEPT", "sender": "B004", "target": "A017",
  "proposal_id": "A017-43-882", "winner": "A017", "cost": 17.3, "priority": 1 }
```

### `TRAJECTORY_REJECT`

```json
{ "type": "TRAJECTORY_REJECT", "sender": "B004", "target": "A017",
  "proposal_id": "A017-43-882", "winner": "B004", "reason": "unsafe" }
```

### `TRAJECTORY_COMMIT`

```json
{ "type": "TRAJECTORY_COMMIT", "sender": "A017", "sim_time": 18240.1,
  "position": [1100.2, 2330.4, 510.0],
  "velocity": [145.0, 35.0, 0.0], "heading": 1.99, "speed": 149.2,
  "vertical_rate": 0.0, "destination": [12000.0, 9000.0, 1500.0],
  "priority": 1, "emergency": false, "trajectory_version": 43,
  "plan": [[145.0, 35.0, 0.0], 3.0] }
```

## Conflict Resolution Determinism

Both aircraft in a conflict run the same ordering rule:

```
1. Priority (higher wins)
2. Trajectory cost (lower wins)
3. Trajectory version (higher wins)
4. Aircraft ID (lexicographically smaller wins)
```

This guarantees a unique deterministic outcome without a central coordinator.
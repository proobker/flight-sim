"""Neighbor discovery and local world model.

Each aircraft keeps a neighbor table built from STATE_UPDATE / HELLO frames.
Entries decay through ACTIVE → STALE → UNRESPONSIVE and carry an expanding
uncertainty radius that represents growing doubt about a silent peer's true
position.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

ACTIVE = "ACTIVE"
STALE = "STALE"
UNRESPONSIVE = "UNRESPONSIVE"


@dataclass
class NeighborEntry:
    aircraft_id: str
    last_seen: float = 0.0
    position: tuple[float, float, float] = (0.0, 0.0, 0.0)
    velocity: tuple[float, float, float] = (0.0, 0.0, 0.0)
    heading: float = 0.0
    speed: float = 0.0
    vertical_rate: float = 0.0
    destination: tuple[float, float, float] = (0.0, 0.0, 0.0)
    priority: int = 0
    emergency: bool = False
    trajectory_version: int = 0
    plan: list[tuple[float, float, float]] = field(default_factory=list)
    confidence: float = 1.0

    def age(self, now: float) -> float:
        return max(0.0, now - self.last_seen)

    def state(self, stat_timeout: float, hard_timeout: float) -> str:
        age = self.age(0.0)
        if age >= hard_timeout:
            return UNRESPONSIVE
        if age >= stat_timeout:
            return STALE
        return ACTIVE

    def uncertainty_radius(self, now: float, base: float, growth: float) -> float:
        return base + growth * self.age(now)


class NeighborTable:
    def __init__(
        self,
        node_id: str,
        stale_timeout: float = 2.0,
        hard_timeout: float = 5.0,
        base_uncertainty: float = 150.0,
        uncertainty_growth: float = 40.0,
    ) -> None:
        self.node_id = node_id
        self.stale_timeout = stale_timeout
        self.hard_timeout = hard_timeout
        self.base_uncertainty = base_uncertainty
        self.uncertainty_growth = uncertainty_growth
        self.entries: dict[str, NeighborEntry] = {}

    def upsert(self, msg: dict[str, Any], now: float) -> None:
        sender = msg.get("sender")
        if not sender or sender == self.node_id:
            return
        entry = self.entries.get(sender)
        if entry is None:
            entry = NeighborEntry(aircraft_id=sender)
            self.entries[sender] = entry
        entry.last_seen = now
        entry.position = _vec(msg.get("position"))
        entry.velocity = _vec(msg.get("velocity"))
        entry.heading = float(msg.get("heading", 0.0))
        entry.speed = float(msg.get("speed", 0.0))
        entry.vertical_rate = float(msg.get("vertical_rate", 0.0))
        entry.destination = _vec(msg.get("destination"))
        entry.priority = int(msg.get("priority", 0))
        entry.emergency = bool(msg.get("emergency", False))
        entry.trajectory_version = int(msg.get("trajectory_version", 0))
        raw_plan = msg.get("plan")
        if isinstance(raw_plan, list):
            entry.plan = [_vec(p) for p in raw_plan if _valid(p)]

    def prune(self, now: float, ttl: float = 20.0) -> None:
        for nid in [k for k, e in self.entries.items() if e.age(now) > ttl]:
            del self.entries[nid]

    def live_neighbors(self, now: float) -> list[NeighborEntry]:
        return [e for e in self.entries.values() if e.age(now) <= self.hard_timeout]

    def as_dict(self, now: float, own_position: tuple[float, float, float] | None = None) -> list[dict[str, Any]]:
        out = []
        for e in self.entries.values():
            distance = None
            if own_position is not None:
                distance = math.dist(e.position, own_position)
            out.append(
                {
                    "id": e.aircraft_id,
                    "age": e.age(now),
                    "state": e.state(self.stale_timeout, self.hard_timeout),
                    "confidence": e.confidence,
                    "distance": distance,
                }
            )
        return out


def _vec(value: Any) -> tuple[float, float, float]:
    if _valid(value):
        return (float(value[0]), float(value[1]), float(value[2]))
    return (0.0, 0.0, 0.0)


def _valid(value: Any) -> bool:
    return bool(value) and isinstance(value, (list, tuple)) and len(value) >= 3
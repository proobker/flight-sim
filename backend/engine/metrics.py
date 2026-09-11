"""SkyMesh metrics — collected centrally for the dashboard comparison."""

from __future__ import annotations

from dataclasses import dataclass

@dataclass
class ConflictRecord:
    a: str
    b: str
    detected_at: float
    resolved_at: float | None = None
    resolution_ms: float | None = None
    maneuver: str = ""


class Metrics:
    def __init__(self) -> None:
        self.conflict_count = 0
        self.resolved_count = 0
        self.min_separation = float("inf")
        self.near_misses = 0
        self.collisions = 0
        self.sum_resolution_ms = 0.0
        self.records: list[ConflictRecord] = []
        self.network_nodes_failed = 0
        self.partition_events = 0
        self.cascading_conflicts = 0

    def record_conflict(self, record: ConflictRecord) -> None:
        self.records.append(record)
        self.conflict_count += 1

    def record_resolution(self, record: ConflictRecord, now: float) -> None:
        record.resolved_at = now
        record.resolution_ms = (now - record.detected_at) * 1000.0
        self.resolved_count += 1
        self.sum_resolution_ms += record.resolution_ms or 0.0

    def observe_min_separation(self, distance: float) -> None:
        if distance < self.min_separation:
            self.min_separation = distance

    def avg_resolution_ms(self) -> float:
        if self.resolved_count == 0:
            return 0.0
        return self.sum_resolution_ms / self.resolved_count

    def as_dict(self) -> dict:
        return {
            "conflicts": self.conflict_count,
            "resolved": self.resolved_count,
            "min_separation": None if self.min_separation == float("inf") else round(self.min_separation, 1),
            "near_misses": self.near_misses,
            "collisions": self.collisions,
            "avg_resolution_ms": round(self.avg_resolution_ms(), 1),
            "nodes_failed": self.network_nodes_failed,
            "partition_events": self.partition_events,
            "cascading_conflicts": self.cascading_conflicts,
        }
"""Airspace world model — bounds and dynamic hazards (no-fly zones, storms)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class Obstacle:
    obs_id: str
    kind: str  # NO_FLY | STORM | AIRPORT
    center: tuple[float, float, float]
    radius: float
    height: float
    active: bool = True

    def contains(self, point: tuple[float, float, float]) -> bool:
        if not self.active:
            return False
        dx = point[0] - self.center[0]
        dy = point[1] - self.center[1]
        dz = abs(point[2] - self.center[2])
        if dz > self.height / 2:
            return False
        return dx * dx + dy * dy <= self.radius * self.radius

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.obs_id,
            "kind": self.kind,
            "center": list(self.center),
            "radius": self.radius,
            "height": self.height,
            "active": self.active,
        }


class Airspace:
    def __init__(
        self,
        width: float = 20000.0,
        depth: float = 20000.0,
        floor: float = 100.0,
        ceiling: float = 6000.0,
    ) -> None:
        self.width = width
        self.depth = depth
        self.floor = floor
        self.ceiling = ceiling
        self.obstacles: list[Obstacle] = []
        self._next_obs = 0

    def center(self) -> tuple[float, float, float]:
        return (self.width / 2, self.depth / 2, (self.ceiling + self.floor) / 2)

    def random_point(self, rng, z: float | None = None) -> tuple[float, float, float]:
        x = rng.uniform(0, self.width)
        y = rng.uniform(0, self.depth)
        if z is None:
            z = rng.uniform(self.floor + 200, self.ceiling - 200)
        return (x, y, z)

    def add_obstacle(self, kind: str, center: tuple[float, float, float], radius: float, height: float) -> Obstacle:
        obs = Obstacle(obs_id=f"{kind}-{self._next_obs}", kind=kind, center=center, radius=radius, height=height)
        self._next_obs += 1
        self.obstacles.append(obs)
        return obs

    def in_bounds(self, point: tuple[float, float, float]) -> bool:
        return (
            0 <= point[0] <= self.width
            and 0 <= point[1] <= self.depth
            and self.floor <= point[2] <= self.ceiling
        )

    def enforce_bounds(self, point: tuple[float, float, float]) -> tuple[float, float, float]:
        return (
            max(0.0, min(self.width, point[0])),
            max(0.0, min(self.depth, point[1])),
            max(self.floor, min(self.ceiling, point[2])),
        )

    def obstacles_between(self, a: tuple[float, float, float], b: tuple[float, float, float], obstacle_clearance: float = 300.0) -> list[Obstacle]:
        hits = []
        for obs in self.obstacles:
            if not obs.active:
                continue
            if _segment_intersects_cylinder(a, b, obs, obstacle_clearance):
                hits.append(obs)
        return hits

    def snapshot(self) -> dict[str, Any]:
        return {
            "width": self.width,
            "depth": self.depth,
            "floor": self.floor,
            "ceiling": self.ceiling,
            "obstacles": [o.snapshot() for o in self.obstacles if o.active],
        }


def _segment_intersects_cylinder(
    a: tuple[float, float, float],
    b: tuple[float, float, float],
    obs: Obstacle,
    clearance: float,
) -> bool:
    r = obs.radius + clearance
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    d2 = dx * dx + dy * dy
    if d2 < 1e-9:
        return obs.contains(a)
    fx = a[0] - obs.center[0]
    fy = a[1] - obs.center[1]
    t = -(fx * dx + fy * dy) / d2
    t = max(0.0, min(1.0, t))
    px = a[0] + dx * t
    py = a[1] + dy * t
    if (px - obs.center[0]) ** 2 + (py - obs.center[1]) ** 2 > r * r:
        return False
    pz = a[2] + (b[2] - a[2]) * t
    return abs(pz - obs.center[2]) <= obs.height / 2 + clearance
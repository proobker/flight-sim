"""Airspace world model — bounds and dynamic hazards (no-fly zones, storms)."""

from __future__ import annotations

import math
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

    def waypoint_around(
        self,
        a: tuple[float, float, float],
        b: tuple[float, float, float],
        clearance: float = 300.0,
    ) -> tuple[float, float, float] | None:
        """Horizontal avoidance waypoint for the straight segment a→b.

        Computes a midpoint-offset detour: the waypoint is placed
        perpendicular to the straight path at the point nearest the first
        blocking obstacle, outside the protected disc. Both legs a→wp and
        wp→b then clear the obstacle. Returns None when the path is clear.
        """
        hits = self.obstacles_between(a, b, clearance)
        if not hits:
            return None
        hits.sort(key=lambda o: _closest_point_param(a, b, o))
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < 1e-9:
            return None
        ux, uy = dx / length, dy / length
        nx, ny = -uy, ux
        margin = 120.0
        best: tuple[float, float, float] | None = None
        best_cost = math.inf
        for obs in hits:
            R = obs.radius + clearance
            t_param = (obs.center[0] - a[0]) * ux + (obs.center[1] - a[1]) * uy
            t_param = max(0.0, min(length, t_param))
            px = a[0] + ux * t_param
            py = a[1] + uy * t_param
            for sign in (1.0, -1.0):
                wx = px + nx * (R + margin) * sign
                wy = py + ny * (R + margin) * sign
                if wx < 0 or wx > self.width or wy < 0 or wy > self.depth:
                    continue
                leg = math.hypot(wx - a[0], wy - a[1]) + math.hypot(b[0] - wx, b[1] - wy)
                if leg < best_cost:
                    best_cost = leg
                    best = (wx, wy, a[2])
        if best is None:
            return None
        return self.enforce_bounds(best)

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


def _closest_point_param(
    a: tuple[float, float, float],
    b: tuple[float, float, float],
    obs: Obstacle,
) -> float:
    """Parameter t ∈ [0, 1] of the point on segment a→b nearest the obstacle."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    d2 = dx * dx + dy * dy
    if d2 < 1e-9:
        return 0.0
    fx = a[0] - obs.center[0]
    fy = a[1] - obs.center[1]
    t = -(fx * dx + fy * dy) / d2
    return max(0.0, min(1.0, t))
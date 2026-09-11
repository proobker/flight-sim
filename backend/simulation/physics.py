"""SkyMesh physics — movement, prediction, geometry helpers.

Coordinates are (x, y, z) meters in a local horizontal plane plus altitude.
Genuinely decentralized: every aircraft integrates its own state from the
trajectory it has committed to.
"""

from __future__ import annotations

import math

V = tuple[float, float, float] | None


def norm(v: V) -> float:
    if v is None:
        return 0.0
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def distance(a: V, b: V) -> float:
    return math.dist(a or (0, 0, 0), b or (0, 0, 0))


def distance2(a: V, b: V) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2


def h_distance(a: V, b: V) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def advance(position: V, velocity: V, dt: float) -> tuple[float, float, float]:
    return (
        position[0] + velocity[0] * dt,
        position[1] + velocity[1] * dt,
        position[2] + velocity[2] * dt,
    )


def to_velocity(heading_rad: float, speed: float, vertical_rate: float) -> tuple[float, float, float]:
    return (
        math.sin(heading_rad) * speed,
        math.cos(heading_rad) * speed,
        vertical_rate,
    )


def heading_to(v: V, target: V) -> float:
    return math.atan2(target[0] - v[0], target[1] - v[1])


def clamp_altitude(z: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, z))


def closest_approach(
    a: tuple[float, float, float], va: tuple[float, float, float],
    b: tuple[float, float, float], vb: tuple[float, float, float],
    horizon: float,
) -> tuple[float, float]:
    """Return (time-of-closest-approach, distance-at-closest) within [0, horizon]."""
    d = (a[0] - b[0], a[1] - b[1], a[2] - b[2])
    v = (va[0] - vb[0], va[1] - vb[1], va[2] - vb[2])
    v2 = norm(v) ** 2
    if v2 < 1e-9:
        return 0.0, norm(d)
    t = -(d[0] * v[0] + d[1] * v[1] + d[2] * v[2]) / v2
    t = max(0.0, min(horizon, t))
    dp = (d[0] + v[0] * t, d[1] + v[1] * t, d[2] + v[2] * t)
    return t, norm(dp)


def points_along(
    start: V, velocity: V, horizon: float, step: float,
) -> list[tuple[float, float, float]]:
    pts: list[tuple[float, float, float]] = []
    t = 0.0
    while t <= horizon + 1e-9:
        pts.append(advance(start, velocity, t))
        t += step
    return pts
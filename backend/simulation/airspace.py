"""Airspace world model — bounds, airports, runways, and dynamic hazards."""

from __future__ import annotations

import math
import random
import statistics
from dataclasses import dataclass
from typing import Any

import numpy as np

from .fleet import AircraftType
from . import physics
from .terrain import (
    CRUISE_TERRAIN_BUFFER,
    TERRAIN_MIN_CLEARANCE,
    TerrainGrid,
    flatten_airports,
    relief_mesh,
    terrace_radii,
)

AIRPORT_NAMES = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT"]

# Random airport placement: keep the fields spaced like a metroplex, and never
# let a terraced plateau land up in the mountains (planes cruise 1500-4000 m
# and the terrain is real). The hub keeps more freedom than the relievers, and
# the retry loop reseeds its RNG each attempt, so a fixed terrain_seed always
# reproduces the same layout.
_PLACEMENT_TRIES = 20
_PLATEAU_CAP_HUB = 3800.0
_PLATEAU_CAP_RELIEF = 2600.0

# Discrete cruise levels so neighbouring flights sit in different bands.
# Spaced 600-900 m apart (well above the 300 m vertical separation standard
# plus the +/-150 m jitter) so adjacent bands never conflict vertically;
# the top band clears the tallest route crests (terrain zmax ~4700 m).
ALTITUDE_BANDS = [1500.0, 2100.0, 2700.0, 3300.0, 4000.0, 4800.0, 5400.0]

# Distance from an airport inside which terminal (3 km) separation applies
# instead of the en-route (5 km) standard.
TERMINAL_RADIUS = 40000.0


def random_cruise_altitude(rng=None) -> float:
    rng = rng or random
    return rng.choice(ALTITUDE_BANDS) + rng.uniform(-150.0, 150.0)


def cruise_altitude_over_route(band_alt: float, terrain, hold, dest) -> float:
    """Raise a band-based cruise altitude clear of the terrain along hold→dest.

    Without this, a route over the central massif cruises below the crests and
    the TAWS floor shoves the flight onto TERRAIN_MIN_CLEARANCE (250 m) above the
    ridge line, which reads as the aircraft scraping the ground. Raising the
    cruise by CRUISE_TERRAIN_BUFFER over the route's tallest crest keeps the
    planned altitude above every crest, so cruise stays smooth and well clear.
    """
    if terrain is None:
        return band_alt
    crest, _ = terrain.max_along(hold, dest, step=200.0)
    return max(band_alt, crest + CRUISE_TERRAIN_BUFFER)


@dataclass
class Runway:
    """A real runway: heading, length, and the touchdown (threshold) point.

    `heading` is the inbound direction of travel in radians: aircraft land and
    roll out moving along it, and departures accelerate along it from the
    far end toward the threshold.
    """

    rid: str
    heading: float
    length: float
    threshold: tuple[float, float, float]
    elevation: float
    width: float = 48.0

    @property
    def u(self) -> tuple[float, float]:
        """Unit vector of travel (final approach / rollout / departure)."""
        return (math.sin(self.heading), math.cos(self.heading))

    @property
    def n(self) -> tuple[float, float]:
        """Pattern side unit vector — left of the direction of travel."""
        return (-math.cos(self.heading), math.sin(self.heading))

    def departure_point(self) -> tuple[float, float, float]:
        ux, uy = self.u
        return (self.threshold[0] - ux * self.length, self.threshold[1] - uy * self.length, self.elevation)

    # Parallel taxiway: how far off the runway centreline the hold pads sit,
    # and the spacing back along the runway between queued departures.
    HOLD_OFFSET = 150.0
    HOLD_STAGGER = 120.0

    def departure_hold_point(self, slot: int = 0) -> tuple[float, float, float]:
        """Off-runway hold pad for a departure, on the pattern side of the
        runway just beyond the departing end. `slot` spreads the queue back
        along the taxiway so waiting aircraft never sit on the asphalt."""
        ux, uy = self.u
        nx, ny = self.n
        x, y, z = self.departure_point()
        return (
            x + nx * self.HOLD_OFFSET - ux * slot * self.HOLD_STAGGER,
            y + ny * self.HOLD_OFFSET - uy * slot * self.HOLD_STAGGER,
            z,
        )

    def approach_fix(self, final_len: float) -> tuple[float, float, float]:
        """Straight-on point on the extended centerline, before the threshold."""
        ux, uy = self.u
        return (self.threshold[0] - ux * final_len, self.threshold[1] - uy * final_len, self.elevation)

    def downwind_entry(self, t: "AircraftType") -> tuple[float, float, float]:
        """Where the pattern begins: abeam, offset onto the pattern side."""
        ux, uy = self.u
        nx, ny = self.n
        p = t.pattern_offset
        return (
            self.threshold[0] + ux * t.downwind_len + nx * p,
            self.threshold[1] + uy * t.downwind_len + ny * p,
            self.gs_alt(t.pattern_alt_agl),
        )

    def downwind_abeam(self, t: "AircraftType") -> tuple[float, float, float]:
        """Turn-from-downwind-to-base point, level with the departure end."""
        ux, uy = self.u
        nx, ny = self.n
        p = t.pattern_offset
        ex, ey, ez = self.departure_point()
        return (ex + nx * p, ey + ny * p, self.gs_alt(t.pattern_alt_agl))

    def pattern_alt(self, t: "AircraftType") -> float:
        return self.gs_alt(t.pattern_alt_agl)

    def gs_alt(self, agl: float) -> float:
        """Field-relative altitude: runway sits on the airspace floor."""
        return self.elevation + agl

    def heading_label(self) -> str:
        deg = int(round((self.heading * 180.0 / math.pi) % 360.0))
        return f"{deg:02d}"

    def into_wind_rating(self, wind: "tuple[float, float, float] | None") -> float:
        """Positive = headwind for landings on this runway (better)."""
        if wind is None:
            return 0.0
        ux, uy = self.u
        return -(wind[0] * ux + wind[1] * uy)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.rid,
            "heading": round(self.heading, 4),
            "heading_label": self.heading_label(),
            "length": self.length,
            "threshold": list(self.threshold),
            "elevation": self.elevation,
        }


@dataclass
class Airport:
    """A landing field aircraft spawn from and fly to.

    Runways are assigned lazily on first access (after the default world is
    built) so tests that construct bare `Airport`s keep working.
    """

    aid: str
    name: str
    position: tuple[float, float, float]
    radius: float = 1200.0
    closed: bool = False
    hub: bool = False
    runways: list[Runway] = None  # type: ignore[assignment]

    def _ensure_runways(self) -> None:
        if self.runways is None:
            self.runways = _build_runways(self)

    def active_runway(self, wind=None) -> Runway:
        """Runway with the best headwind component, or the first."""
        self._ensure_runways()
        return max(self.runways, key=lambda r: (r.into_wind_rating(wind), r.heading == self.runways[0].heading))

    def snapshot(self) -> dict[str, Any]:
        self._ensure_runways()
        return {
            "id": self.aid,
            "name": self.name,
            "center": list(self.position),
            "radius": self.radius,
            "closed": self.closed,
            "hub": self.hub,
            "runways": [r.snapshot() for r in self.runways],
        }


# Inbound headings (rad) per airport. Varied so traffic patterns do not stack.
_RUNWAY_SPECS: dict[str, tuple] = {
    "APT1": ((math.radians(62), 3400.0), (math.radians(143), 3000.0)),
    "APT2": ((math.radians(98), 2700.0),),
    "APT3": ((math.radians(250), 2400.0),),
    "APT4": ((math.radians(358), 1900.0),),
    "APT5": ((math.radians(300), 1800.0),),
    "APT6": ((math.radians(207), 1800.0),),
}


def _build_runways(airport: Airport) -> list[Runway]:
    elev = airport.position[2]
    specs = _RUNWAY_SPECS.get(airport.aid)
    if specs is None:
        specs = ((math.radians(90), max(1800.0, airport.radius * 2.2)),)
    out: list[Runway] = []
    for i, (heading, length) in enumerate(specs):
        ux, uy = math.sin(heading), math.cos(heading)
        # Threshold sits 55% of runway length ahead of the pad; the pad is the
        # taxi-in target roughly mid-runway.
        thr = (airport.position[0] + ux * length * 0.55, airport.position[1] + uy * length * 0.55, elev)
        out.append(
            Runway(
                rid=f"{airport.aid}-R{i + 1}",
                heading=heading,
                length=length,
                threshold=thr,
                elevation=elev,
            )
        )
    return out


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
        width: float = 160000.0,
        depth: float = 160000.0,
        floor: float = 100.0,
        ceiling: float = 6000.0,
        airports: list[Airport] | None = None,
        wind: tuple[float, float, float] | None = None,
        terrain: TerrainGrid | None = None,
        terrain_seed: int | None = None,
    ) -> None:
        self.width = width
        self.depth = depth
        self.floor = floor
        self.ceiling = ceiling
        self.wind = wind
        self.obstacles: list[Obstacle] = []
        self.airports: list[Airport] = (
            airports if airports is not None else self._default_airports(self._layout_rng(terrain_seed))
        )
        self._airports_defaulted = airports is None
        for a in self.airports:
            self.add_runways_for(a)
        self.terrain = terrain
        if self.terrain is None and terrain_seed is not None:
            if self._airports_defaulted:
                self.terrain = self._build_accepted_terrain(seed=terrain_seed)
            else:
                self.terrain = TerrainGrid.from_airspace(self, seed=terrain_seed)
        self._next_obs = 0

    @staticmethod
    def _layout_rng(terrain_seed: int | None) -> random.Random:
        # Seeded → every launch with the same seed shows the same random layout
        # (tests and vertical slice depend on it). No seed → fresh spots a run.
        return random.Random(seed) if (seed := terrain_seed) is not None else random.Random()

    def _default_airports(self, rng: random.Random) -> list[Airport]:
        """Six fields: one hub near centre (slight jitter) plus reliever fields
        at random spots, spaced like a metroplex across the field."""
        w, d = self.width, self.depth
        margin = 0.08
        cx, cy = w * 0.5, d * 0.5
        spots = [
            (
                cx + rng.uniform(-0.03, 0.03) * w,
                cy + rng.uniform(-0.03, 0.03) * d,
                True,
            )
        ]
        min_sep = min(w, d) * 0.2
        attempts = 0
        while len(spots) < 6:
            attempts += 1
            if attempts > 1500:  # soften the spacing only if the field is full
                min_sep *= 0.95
                attempts = 0
            cand = (
                rng.uniform(margin, 1.0 - margin) * w,
                rng.uniform(margin, 1.0 - margin) * d,
                False,
            )
            if all(math.hypot(cand[0] - sx, cand[1] - sy) >= min_sep for sx, sy, _ in spots):
                spots.append(cand)
        pads: list[Airport] = []
        for i, (x, y, hub) in enumerate(spots):
            pads.append(
                Airport(
                    aid=f"APT{i + 1}",
                    name=AIRPORT_NAMES[i],
                    position=(x, y, self.floor + 40.0),
                    radius=1400.0 if hub else 1200.0,
                    hub=hub,
                )
            )
        return pads

    def _build_accepted_terrain(self, seed: int) -> TerrainGrid:
        """Build the flat-terraced terrain, re-picking the random layout until
        every plateau stays low and grades sanely against its surroundings.

        The raw relief mesh is generated once; each candidate layout is screened
        with the cheap PURE flatten (no airport mutation, no full rebuild), and
        every attempt gets its own layout RNG so rejected layouts actually
        change. Deterministic for a given seed: the per-attempt seeds are
        derived from it, so the whole sequence replays exactly."""
        raw, xs, ys, x0, y0, cell = relief_mesh(self, seed)
        for attempt in range(_PLACEMENT_TRIES):
            h, elevs = flatten_airports(raw, xs, ys, self)
            if self._layout_acceptable(h, elevs, x0, y0, cell):
                # Commit: patch plateau elevations onto airports + runways.
                for apt, elev in zip(self.airports, elevs):
                    ax, ay, _ = apt.position
                    apt.position = (ax, ay, float(elev))
                    for r in apt.runways or []:
                        r.elevation = float(elev)
                        tx, ty, _ = r.threshold
                        r.threshold = (tx, ty, float(elev))
                return TerrainGrid(
                    grid=np.ascontiguousarray(h, dtype=np.float32),
                    x0=x0,
                    y0=y0,
                    cell=cell,
                    zmin=float(h.min()),
                    zmax=float(h.max()),
                    bounds=(0.0, 0.0, self.width, self.depth),
                )
            self.airports = self._default_airports(self._layout_rng(seed + attempt + 1))
            for a in self.airports:
                self.add_runways_for(a)
        # No layout met every cap (pathological seed) — fall back to the last
        # candidate rather than fail startup; the plateau caps are a preference.
        return TerrainGrid.from_airspace(self, seed=seed)

    def _layout_acceptable(self, h, elevs, x0, y0, cell) -> bool:
        """Screen a flattened grid: plateau within per-airport caps, and not
        far from the ring just beyond the rim (outliers — mountain wedges —
        can't skew the robust median)."""
        def sample(px, py):
            ix = int(np.clip((px - x0) / cell, 0, h.shape[1] - 1))
            iy = int(np.clip((py - y0) / cell, 0, h.shape[0] - 1))
            return h[iy][ix]

        for apt, elev in zip(self.airports, elevs):
            cap = _PLATEAU_CAP_HUB if apt.hub else _PLATEAU_CAP_RELIEF
            if elev > cap:
                return False
            _, R_out = terrace_radii(apt)
            ring_r = R_out * 1.3
            ring = [
                sample(
                    apt.position[0] + math.cos(k * 2 * math.pi / 64) * ring_r,
                    apt.position[1] + math.sin(k * 2 * math.pi / 64) * ring_r,
                )
                for k in range(64)
            ]
            med = statistics.median(ring)
            if not (med - 250.0 <= elev <= med + 550.0):
                return False
        return True

    def pick_runway(self, airport: Airport) -> Runway:
        """The arrival runway an inbound flight will be assigned."""
        airport._ensure_runways()
        if not airport.runways:
            raise RuntimeError(f"airport {airport.aid} has no runways")
        return airport.active_runway(wind=getattr(self, "wind", None))

    def add_runways_for(self, airport: Airport) -> None:
        airport._ensure_runways()

    def random_airport(self, rng=None, exclude_id: str | None = None) -> Airport:
        rng = rng or random
        candidates = [a for a in self.airports if not a.closed and a.aid != exclude_id]
        if not candidates:
            candidates = [a for a in self.airports if a.aid != exclude_id] or self.airports
        return rng.choice(candidates)

    def airport_by_id(self, aid: str) -> Airport | None:
        for a in self.airports:
            if a.aid == aid:
                return a
        return None

    def next_destination(self, exclude_id: str | None = None) -> tuple[float, float, float]:
        return self.random_airport(exclude_id=exclude_id).position

    def close_airport(self, aid: str | None = None, rng=None):
        open_ports = [a for a in self.airports if not a.closed]
        if not open_ports:
            return None
        target = self.airport_by_id(aid) if aid else (rng or random).choice(open_ports)
        if target is None:
            return None
        target.closed = True
        return target

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

    # ----- terrain (elevation model) -----

    def terrain_height(self, x: float, y: float) -> float:
        """Elevation [m] at a ground point (0 when terrain is disabled)."""
        if self.terrain is None:
            return 0.0
        return self.terrain.height_at(x, y)

    def ground_alt(self, x: float, y: float, fallback: float) -> float:
        """Altitude for an object sitting on the ground at (x, y): the local
        terrain surface, never below it. Ground holds / spawns use this so a
        craft standing anywhere can never sink into the heightfield."""
        if self.terrain is None:
            return fallback
        return max(fallback, self.terrain.height_at(x, y))

    def terrain_detour_waypoint(
        self,
        a: tuple[float, float, float],
        b: tuple[float, float, float],
        current_alt: float,
        clearance: float = TERRAIN_MIN_CLEARANCE,
    ) -> tuple[float, float, float] | None:
        if self.terrain is None:
            return None
        return self.terrain.detour_waypoint(a, b, current_alt, clearance)

    def terrain_motion_clear(
        self,
        start: tuple[float, float, float],
        velocity: tuple[float, float, float],
        duration: float,
        clearance: float = TERRAIN_MIN_CLEARANCE,
    ) -> bool:
        if self.terrain is None:
            return True
        return self.terrain.motion_clearance_ok(start, velocity, duration, clearance)

    def snapshot(self) -> dict[str, Any]:
        snap = {
            "width": self.width,
            "depth": self.depth,
            "floor": self.floor,
            "ceiling": self.ceiling,
            "airports": [a.snapshot() for a in self.airports],
            "obstacles": [o.snapshot() for o in self.obstacles if o.active],
        }
        if self.terrain is not None:
            snap["terrain"] = self.terrain.metadata()
        return snap


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
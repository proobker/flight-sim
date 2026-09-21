"""TerrainGrid — the simulation's elevation model.

Fictional-but-realistic terrain built deterministically from a seed: a
coastal plain and valley system where the airports sit, flanked by a tall
mountain massif whose crests climb toward the airspace ceiling. Both the
simulation (physics/detection) and the frontend (rendering) read the exact
same grid, so planes never fly through mountains on screen.

The grid is generated once (NumPy, vectorised) and served to the frontend
via ``GET /api/terrain`` as a gzip'd Float32 heightmap.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

# Minimum vertical clearance aircraft aim to keep above the terrain (m).
TERRAIN_MIN_CLEARANCE = 250.0
# How far above the highest crest along a route a cruise altitude is raised,
# so en-route traffic flies comfortably over terrain instead of riding the
# TERRAIN_MIN_CLEARANCE floor along ridge lines.
CRUISE_TERRAIN_BUFFER = 800.0
# Look-ahead window while scanning for rising terrain (seconds of flight).
TERRAIN_LOOKAHEAD_S = 15.0
# How far past the airspace edge the grid extends (fraction of half extent);
# the ground literally "stretches out very far" beyond the flyable zone.
_EDGE_MARGIN = 0.25

_ZMIN = 100.0
_ZMAX = 4700.0
_DEFAULT_CELL = 250.0


def _smooth(t):
    return t * t * (3.0 - 2.0 * t)


def _noise_field(xs, ys, rng, scale0, octaves, kind="fbm"):
    """Value-noise fBm evaluated at arbitrary coordinate arrays.

    ``kind`` is ``"fbm"`` or ``"ridged"``; both return values in [0, 1].
    """
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    xmin, ymin = xs.min(), ys.min()
    xmax, ymax = xs.max(), ys.max()
    extent = max(xmax - xmin, ymax - ymin)

    total = np.zeros(xs.shape, dtype=np.float64)
    norm = 0.0
    amp = 1.0
    scale = scale0
    for _ in range(octaves):
        spacing = scale / (2.0 ** _)
        L = max(4, int(math.ceil(extent / spacing)) + 3)
        lat = rng.random((L, L))
        gx = np.clip((xs - xmin) / spacing, 0.0, L - 1 - 1e-6)
        gy = np.clip((ys - ymin) / spacing, 0.0, L - 1 - 1e-6)
        xi = gx.astype(np.intp)
        yi = gy.astype(np.intp)
        fx = _smooth(gx - xi)
        fy = _smooth(gy - yi)
        v00 = lat[yi, xi]
        v10 = lat[yi, xi + 1]
        v01 = lat[yi + 1, xi]
        v11 = lat[yi + 1, xi + 1]
        top = v00 + (v10 - v00) * fx
        bot = v01 + (v11 - v01) * fx
        v = top + (bot - top) * fy
        if kind == "ridged":
            v = (1.0 - np.abs(2.0 * v - 1.0)) ** 2
        total += amp * v
        norm += amp
        amp *= 0.5
    return total / norm


def _segment_distances(points, segs):
    """Min distance from each point to a polyline (vectorised)."""
    best = np.full(len(points), np.inf)
    for (x1, y1), (x2, y2) in zip(segs, segs[1:]):
        vx, vy = x2 - x1, y2 - y1
        len2 = vx * vx + vy * vy
        if len2 < 1e-9:
            d = np.hypot(points[:, 0] - x1, points[:, 1] - y1)
            best = np.minimum(best, d)
            continue
        t = np.clip(((points[:, 0] - x1) * vx + (points[:, 1] - y1) * vy) / len2, 0.0, 1.0)
        px = x1 + vx * t
        py = y1 + vy * t
        best = np.minimum(best, np.hypot(points[:, 0] - px, points[:, 1] - py))
    return best


# Matches the frontend AIRPORT_SITE_SCALE in SkyScene.ts. The site visuals are
# scaled ~2x — the apron ring reaches radius * 1.2 * scale — so the flat
# terrace must cover pad, apron, beacon ring and the full runway length, with a
# little margin left under the graded rim.
AIRPORT_SITE_SCALE = 2.0


def terrace_radii(apt) -> tuple[float, float]:
    """(R_flat, R_out) for an airport: exact-flat out to R_flat, then smoothly
    graded back to raw relief across the rim (R_flat → R_out)."""
    runway_reach = max((0.55 * r.length for r in (apt.runways or [])), default=0.0)
    R_flat = max(apt.radius * (1.2 * AIRPORT_SITE_SCALE) + 300.0, runway_reach + 800.0, 2800.0)
    R_out = R_flat + max(apt.radius * 1.1, 1800.0)
    return R_flat, R_out


def _raw_relief(xs, ys, cx, cy, seed) -> np.ndarray:
    """Base relief (steps 1-3 of the grid build) evaluated at arbitrary points.
    Resets the RNG from `seed` exactly like the full build, so point samples
    agree with the grid: landing fields can be pre-screened cheaply before the
    one expensive flattened rebuild."""
    rng = np.random.default_rng(seed)
    lx = xs - cx
    ly = ys - cy

    # 1) Coastal plain with soft rolling relief.
    base = 200.0 + 150.0 * (_noise_field(lx, ly, rng, 5200.0, 4, "fbm") - 0.5)

    # 2) Mountain massif: overlapping ridged spines rising to the NE.
    def spine(angle, width, amp, along_scale):
        c = math.cos(angle)
        s = math.sin(angle)
        across = -lx * s + ly * c
        along = lx * c + ly * s
        band = np.exp(-((across / width) ** 2) / 2.0)
        rn = _noise_field(along, across, rng, along_scale, 4, "ridged")
        return band * amp * (0.28 + 0.72 * rn)

    mountains = (
        spine(-0.65, 11000.0, 3600.0, 9000.0)  # main SW↔NE range through the east
        + spine(0.60, 8000.0, 1800.0, 7000.0)  # secondary NW↔SE range
        + spine(1.75, 5500.0, 1000.0, 6000.0)  # perimeter foothills
    )

    # 3) Valley system carved through the lowlands (airports nest here).
    valley_poly = [
        (40.0, 60.0),
        (60.0, 52.0),
        (80.0, 80.0),
        (100.0, 92.0),
        (120.0, 105.0),
    ]
    valley_segs = [(x * 1000.0, y * 1000.0) for x, y in valley_poly]
    pts = np.column_stack([np.asarray(xs).ravel(), np.asarray(ys).ravel()])
    vdist = _segment_distances(pts, valley_segs).reshape(np.asarray(xs).shape)
    valley = 470.0 * np.exp(-((vdist / 12000.0) ** 2))

    h = base + mountains - valley
    return np.clip(h, _ZMIN, _ZMAX)


def relief_mesh(airspace, seed: int = 1337, cell: float = _DEFAULT_CELL):
    """Grid geometry + RAW relief for an airspace (steps 1-3, un-flattened).

    Returns (h, xs, ys, x0, y0, cell). The airspace layout pre-screen builds
    this once and runs the cheap pure `flatten_airports` per candidate layout;
    the authoritative build (`from_airspace`) uses the exact same mesh.
    """
    cx, cy = airspace.width / 2.0, airspace.depth / 2.0
    half = max(airspace.width, airspace.depth) / 2.0 * (1.0 + _EDGE_MARGIN)
    extent = half * 2.0
    W = int(round(extent / cell)) + 1
    x0 = cx - half
    y0 = cy - half
    j, i = np.mgrid[0:W, 0:W]
    xs = x0 + i * cell
    ys = y0 + j * cell
    return _raw_relief(xs, ys, cx, cy, seed), xs, ys, x0, y0, cell


def flatten_airports(h, xs, ys, airspace):
    """Pure flatten: raise each airport onto a genuinely FLAT terrace that
    covers pad, apron, beacon ring and full runway length, then grade only the
    rim (R_flat → R_out) back up toward the surrounding relief.

    Returns (flattened grid, plateau elevations per airport, in airport order).
    Does NOT mutate the airports or runways — callers patch their elevations
    once they commit to a layout, which lets the layout screen run this cheaply
    per candidate."""

    # Sample window beyond the graded rim: the doubly-bounded annulus is the
    # "surrounding's height". A one-sided ramp (> 0.5) would sweep in the whole
    # airspace and collapse every plateau onto the global mean.
    pts = np.column_stack([xs.ravel(), ys.ravel()])
    LIP = 100.0
    elevs: list[float] = []
    for apt in airspace.airports:
        ax, ay, _ = apt.position
        R_flat, R_out = terrace_radii(apt)
        d = np.hypot(xs - ax, ys - ay)

        surrounding = h[(d >= R_out * 1.15) & (d <= R_out * 1.45)]
        plateau = (
            float(np.mean(surrounding)) + LIP
            if surrounding.size
            else float(h.max())
        )
        elevs.append(plateau)

        # Weight 0 for the entire flat terrace (terrain == elev exactly),
        # rising smoothly to 1 (raw relief) only across the outer rim.
        w = _smooth(np.clip((d - R_flat) / max(R_out - R_flat, 1.0), 0.0, 1.0))
        h = h * w + plateau * (1.0 - w)

        # Flatten the arrival corridor ahead of the runway too.
        for r in apt.runways or []:
            u = r.u
            p0x = r.threshold[0] - u[0] * 10000.0
            p0y = r.threshold[1] - u[1] * 10000.0
            p1x = r.threshold[0] + u[0] * 2000.0
            p1y = r.threshold[1] + u[1] * 2000.0

            dseg = _segment_distances(pts, [(p0x, p0y), (p1x, p1y)]).reshape(xs.shape)
            wseg = _smooth(np.clip(dseg / 1500.0, 0.0, 1.0))
            h = h * wseg + plateau * (1.0 - wseg)

    return h, elevs


@dataclass
class TerrainGrid:
    """Discrete elevation model indexed by grid cell (row = y, col = x)."""

    grid: np.ndarray  # float32 [H, W]; grid[j, i] = elevation at (x0 + i*cell, y0 + j*cell)
    x0: float
    y0: float
    cell: float
    zmin: float
    zmax: float
    bounds: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)

    # ── factories ──────────────────────────────────────────────────────

    @classmethod
    def from_airspace(cls, airspace, seed: int = 1337, cell: float = _DEFAULT_CELL) -> "TerrainGrid":
        """Build the terrain around an airspace, flattening its airports."""
        h, xs, ys, x0, y0, _ = relief_mesh(airspace, seed, cell)
        h, elevs = flatten_airports(h, xs, ys, airspace)
        h = np.ascontiguousarray(h, dtype=np.float32)

        # Patch the plateau elevations onto every airport + runway so physics,
        # terminal patterns and the visual airport all agree with the ground
        # beneath them.
        for apt, elev in zip(airspace.airports, elevs):
            ax, ay, _ = apt.position
            apt.position = (ax, ay, float(elev))
            for r in apt.runways or []:
                r.elevation = float(elev)
                tx, ty, _ = r.threshold
                r.threshold = (tx, ty, float(elev))

        return cls(
            grid=h,
            x0=x0,
            y0=y0,
            cell=cell,
            zmin=float(h.min()),
            zmax=float(h.max()),
            bounds=(0.0, 0.0, airspace.width, airspace.depth),
        )

    # ── lookups ────────────────────────────────────────────────────────

    @property
    def width(self) -> int:
        return self.grid.shape[1]

    @property
    def height(self) -> int:
        return self.grid.shape[0]

    @property
    def x1(self) -> float:
        return self.x0 + self.width * self.cell

    @property
    def y1(self) -> float:
        return self.y0 + self.height * self.cell

    def _cell_coords(self, x: float, y: float) -> tuple[int, int, float, float, int, int]:
        fx = (x - self.x0) / self.cell
        fy = (y - self.y0) / self.cell
        fx = min(max(fx, 0.0), self.width - 1 - 1e-6)
        fy = min(max(fy, 0.0), self.height - 1 - 1e-6)
        xi = int(fx)
        yi = int(fy)
        return xi, yi, fx - xi, fy - yi, min(xi + 1, self.width - 1), min(yi + 1, self.height - 1)

    def height_at(self, x: float, y: float) -> float:
        """Bilinear elevation query for any point (clamped at the edges)."""
        xi, yi, fx, fy, xj, yj = self._cell_coords(x, y)
        v00 = float(self.grid[yi, xi])
        v10 = float(self.grid[yi, xj])
        v01 = float(self.grid[yj, xi])
        v11 = float(self.grid[yj, xj])
        top = v00 + (v10 - v00) * fx
        bot = v01 + (v11 - v01) * fx
        return top + (bot - top) * fy

    def max_along(self, a: tuple[float, float, float], b: tuple[float, float, float], step: float = 250.0) -> tuple[float, float]:
        """(max elevation, fraction-along-segment where it occurs) for a→b."""
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            return self.height_at(a[0], a[1]), 0.0
        n = max(2, int(math.ceil(length / step)))
        best = -math.inf
        best_t = 0.0
        for k in range(n + 1):
            t = k / n
            x = a[0] + dx * t
            y = a[1] + dy * t
            e = self.height_at(x, y)
            if e > best:
                best = e
                best_t = t
        return best, best_t

    def segment_clearance_ok(self, p: tuple[float, float, float], q: tuple[float, float, float], clearance: float = TERRAIN_MIN_CLEARANCE) -> bool:
        """True when every sampled point of p→q keeps `clearance` above terrain."""
        dx = q[0] - p[0]
        dy = q[1] - p[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            return height_check(self, p, clearance)
        n = max(2, int(math.ceil(length / 250.0)))
        for k in range(n + 1):
            t = k / n
            pt = (p[0] + dx * t, p[1] + dy * t, p[2] + (q[2] - p[2]) * t)
            if not height_check(self, pt, clearance):
                return False
        return True

    def motion_clearance_ok(self, start, velocity, duration: float, clearance: float = TERRAIN_MIN_CLEARANCE) -> bool:
        """True when flying along `velocity` for `duration` keeps clear of terrain."""
        end = (
            start[0] + velocity[0] * duration,
            start[1] + velocity[1] * duration,
            start[2] + velocity[2] * duration,
        )
        return self.segment_clearance_ok(start, end, clearance)

    def detour_waypoint(
        self,
        a: tuple[float, float, float],
        b: tuple[float, float, float],
        current_alt: float,
        clearance: float = TERRAIN_MIN_CLEARANCE,
    ) -> tuple[float, float, float] | None:
        """Lateral waypoint so both legs fly clear of terrain at `current_alt`.

        Returns None when the straight line can already be overflown at the
        given altitude or no lateral escape was found.
        """
        max_e, _ = self.max_along(a, b, step=250.0)
        if max_e + clearance <= current_alt - 20.0:
            return None

        dx = b[0] - a[0]
        dy = b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            return None
        ux, uy = dx / length, dy / length
        nx, ny = -uy, ux
        _, tmax = self.max_along(a, b, step=250.0)
        px = a[0] + ux * tmax * length
        py = a[1] + uy * tmax * length
        lo, hi = self.bounds[0], self.bounds[2]
        lo_y, hi_y = self.bounds[1], self.bounds[3]

        best: tuple[float, float, float] | None = None
        best_cost = math.inf
        for sign in (1.0, -1.0):
            for off in (3000.0, 5000.0, 7000.0, 9000.0, 12000.0):
                wx = px + nx * off * sign
                wy = py + ny * off * sign
                if not (lo <= wx <= hi and lo_y <= wy <= hi_y):
                    continue
                if self.height_at(wx, wy) + clearance > current_alt + 20.0:
                    continue
                wp = (wx, wy, current_alt)
                if not self.segment_clearance_ok(a, wp, clearance):
                    continue
                if not self.segment_clearance_ok(wp, b, clearance):
                    continue
                cost = math.hypot(wx - a[0], wy - a[1]) + math.hypot(b[0] - wx, b[1] - wy)
                if cost < best_cost:
                    best_cost = cost
                    best = wp
        return best

    def square(self) -> tuple[float, float, float, float]:
        return (self.x0, self.y0, self.x1, self.y1)

    def metadata(self) -> dict[str, Any]:
        return {
            "x0": round(self.x0, 1),
            "y0": round(self.y0, 1),
            "cell": self.cell,
            "width": self.width,
            "height": self.height,
            "zmin": round(self.zmin, 1),
            "zmax": round(self.zmax, 1),
        }

    def to_bytes(self) -> bytes:
        # Contract: the grid is always exported as row-major float32, so the
        # wire size is exactly width*height*4 regardless of internal dtype.
        return np.ascontiguousarray(self.grid, dtype=np.float32).tobytes()

    @classmethod
    def from_bytes(
        cls,
        blob: bytes,
        x0: float,
        y0: float,
        cell: float,
        zmin: float | None = None,
        zmax: float | None = None,
        bounds: tuple[float, float, float, float] | None = None,
    ) -> "TerrainGrid":
        n = int(round(len(blob) / 4.0))
        side = int(round(n**0.5))
        grid = np.frombuffer(blob, dtype="<f4").reshape(side, side).copy()
        tg = cls(
            grid=grid,
            x0=float(x0),
            y0=float(y0),
            cell=float(cell),
            zmin=float(grid.min()) if zmin is None else float(zmin),
            zmax=float(grid.max()) if zmax is None else float(zmax),
            bounds=bounds if bounds is not None else (0.0, 0.0, 0.0, 0.0),
        )
        return tg


def height_check(terrain: TerrainGrid, point: tuple[float, float, float], clearance: float) -> bool:
    return terrain.height_at(point[0], point[1]) + clearance <= point[2]
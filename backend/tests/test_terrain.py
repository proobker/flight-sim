"""Tests for the terrain elevation model and aircraft terrain awareness."""

import math

import numpy as np
import pytest

from backend.simulation.airspace import Airspace
from backend.simulation.aircraft import CRUISE
from backend.simulation.fleet import AircraftType, NARROW, WIDEBODY
from backend.simulation.terrain import CRUISE_TERRAIN_BUFFER, TERRAIN_MIN_CLEARANCE, TerrainGrid

_FLEET = {
    "narrow": AircraftType(
        name=NARROW, wake="MEDIUM", min_speed=60.0, max_speed=255.0,
        cruise_speed=230.0, climb_speed=200.0, descend_speed=190.0,
        approach_speed=72.0, climb_rate=18.0, descend_rate=12.0,
        turn_rate=0.22, acceleration=2.0, braking=1.5,
        pattern_offset=5000.0, pattern_alt_agl=610.0, downwind_len=15000.0,
        final_len=15000.0, roll_len=2000.0,
    ),
    "fast": AircraftType(
        name=WIDEBODY, wake="HEAVY", min_speed=70.0, max_speed=260.0,
        cruise_speed=245.0, climb_speed=215.0, descend_speed=200.0,
        approach_speed=78.0, climb_rate=40.0, descend_rate=14.0,
        turn_rate=0.12, acceleration=2.0, braking=2.0,
        pattern_offset=5000.0, pattern_alt_agl=610.0, downwind_len=18000.0,
        final_len=16000.0, roll_len=3000.0,
    ),
}

# ── helpers ───────────────────────────────────────────────────────────────


def crafted_grid(peak=2200.0, cell=250.0):
    """A flat 25x25 grid (50km x 50km) with one sharp mountain near the centre-east."""
    n = 25
    grid = np.full((n, n), 200.0, dtype=np.float32)
    for j in range(n):
        for i in range(n):
            d = math.hypot(i - 17, j - 9)
            grid[j, i] = max(200.0, peak * math.exp(-((d / 3.5) ** 2)))
    return TerrainGrid(
        grid=grid,
        x0=0.0,
        y0=0.0,
        cell=cell,
        zmin=200.0,
        zmax=peak,
        bounds=(0.0, 0.0, n * cell, n * cell),
    )


def make_aircraft(terrain, *, x=2000.0, y=2000.0, alt, hdg=0.0, cruise=4600.0, fleet_id="narrow"):
    from backend.simulation.aircraft import Aircraft

    ac = Aircraft(
        aircraft_id="T-1",
        position=(x, y, alt),
        destination=(6000.0, 2000.0, 100.0),
        heading=hdg,
        cruise_altitude=cruise,
        fleet=_FLEET.get(fleet_id, _FLEET["narrow"]),
        terrain=terrain,
    )
    ac.phase = CRUISE
    if fleet_id == "fast":
        ac.climb_rate = 40.0
    return ac


# ── TerrainGrid ───────────────────────────────────────────────────────────


def test_crafted_grid_lookups():
    tg = crafted_grid(peak=3400.0)
    peak_x, peak_y = 17 * tg.cell, 9 * tg.cell
    assert tg.height_at(peak_x, peak_y) == pytest.approx(3400.0, abs=60.0)
    # Far corner is the flat 200m plain.
    assert tg.height_at(2 * tg.cell, 2 * tg.cell) == pytest.approx(200.0, abs=30.0)
    # Edge clamping: querying far outside returns the boundary corner.
    assert tg.height_at(-50000.0, -50000.0) == pytest.approx(200.0, abs=30.0)
    assert tg.height_at(1e6, 1e6) == pytest.approx(tg.height_at(tg.x0 + (tg.grid.shape[1] - 1) * tg.cell, tg.y0 + (tg.grid.shape[0] - 1) * tg.cell), abs=1.0)


def test_metadata_and_bytes_roundtrip():
    tg = crafted_grid(peak=1200.0)
    blob = tg.to_bytes()
    assert len(blob) == tg.grid.nbytes
    meta = tg.metadata()
    assert meta["zmin"] == 200.0
    assert meta["zmax"] == 1200.0
    out = TerrainGrid.from_bytes(blob, tg.x0, tg.y0, tg.cell, meta["zmin"], meta["zmax"], tg.bounds)
    np.testing.assert_array_equal(out.grid, tg.grid)


@pytest.fixture(scope="module")
def real_airspace():
    return Airspace(terrain_seed=1337)


def test_generated_terrain_stats(real_airspace):
    tg = real_airspace.terrain
    assert tg.grid.dtype == np.float32
    assert len(tg.to_bytes()) == tg.width * tg.height * 4
    assert -0.5e-6 <= tg.cell - 250.0 <= 0.5e-6 or tg.cell > 200.0
    assert tg.zmin >= 100.0
    assert tg.zmax <= 4700.0
    assert tg.zmax > 3000.0  # a real mountain range exists


def test_generated_airports_are_flattened(real_airspace):
    for apt in real_airspace.airports:
        h = real_airspace.terrain_height(apt.position[0], apt.position[1])
        assert abs(h - apt.position[2]) < 60.0


def test_generated_airports_sit_on_raised_plateaus(real_airspace):
    """Airports are terraces at the surrounding terrain height (not valleys)."""
    import statistics

    from backend.simulation.terrain import terrace_radii

    for apt in real_airspace.airports:
        # Above the default base floor — "different height than the default."
        assert apt.position[2] > real_airspace.floor + 60.0
        # Runways carry the same elevation as the pad underneath them.
        assert all(abs(r.elevation - apt.position[2]) < 1.0 for r in apt.runways)
        _, r_out = terrace_radii(apt)
        # Densely sample a ring beyond the graded rim (raw surrounding relief)
        # so outliers (a nearby mountain wedge) can't skew the robust picture.
        ring = [
            real_airspace.terrain_height(
                apt.position[0] + math.cos(k * 2 * math.pi / 64) * r_out * 1.3,
                apt.position[1] + math.sin(k * 2 * math.pi / 64) * r_out * 1.3,
            )
            for k in range(64)
        ]
        med = statistics.median(ring)
        # Not sunk into a basin: the plateau sits at or modestly above the
        # local relief (a ~100 m escarpment lip), never far below it.
        assert apt.position[2] >= med - 250.0, f"{apt.aid} depressed below surroundings"
        assert apt.position[2] <= med + 550.0, f"{apt.aid} floats absurdly high"


def test_runway_thresholds_and_holds_sit_on_terrain(real_airspace):
    """Landing thresholds and every departure hold pad stand at or above the
    terrain surface — nothing spawns or sets down below the heightfield."""
    for apt in real_airspace.airports:
        for r in apt.runways:
            tx, ty, te = r.threshold
            assert real_airspace.terrain_height(tx, ty) <= te + 0.5, r.rid
            for slot in range(4):
                hp = r.departure_hold_point(slot)
                assert real_airspace.terrain_height(hp[0], hp[1]) <= hp[2] + 0.5, f"{r.rid} hold {slot}"


def test_ground_alt_never_below_terrain(real_airspace):
    for apt in real_airspace.airports:
        x, y, _ = apt.position
        surf = real_airspace.terrain_height(x, y)
        # A bogus-low fallback is raised to the surface.
        assert real_airspace.ground_alt(x, y, surf - 500.0) == pytest.approx(surf, abs=0.6)
        # An already-above-surface fallback is left alone.
        assert real_airspace.ground_alt(x, y, surf + 1000.0) == pytest.approx(surf + 1000.0)

        for r in apt.runways:
            for slot in range(4):
                hp = r.departure_hold_point(slot)
                above = real_airspace.ground_alt(hp[0], hp[1], r.elevation)
                assert above >= real_airspace.terrain_height(hp[0], hp[1]) - 0.5


def test_ground_alt_with_terrain_disabled():
    a = Airspace()  # no terrain_seed
    assert a.terrain is None
    assert a.ground_alt(12345.0, 54321.0, 500.0) == 500.0


def test_generation_is_deterministic():
    a = Airspace(terrain_seed=1234)
    b = Airspace(terrain_seed=1234)
    np.testing.assert_array_equal(a.terrain.grid, b.terrain.grid)
    c = Airspace(terrain_seed=4321)
    assert not np.array_equal(a.terrain.grid, c.terrain.grid)


def test_random_layout_spaced_and_varied():
    a = Airspace(terrain_seed=1337)
    b = Airspace(terrain_seed=4321)
    verts_a = [apt.position[:2] for apt in a.airports]
    verts_b = [apt.position[:2] for apt in b.airports]
    # Airports don't stack corner-to-corner: every pair is kept apart.
    for i, p in enumerate(verts_a):
        for q in verts_a[i + 1 :]:
            assert math.hypot(p[0] - q[0], p[1] - q[1]) >= 15000.0
    # Different seeds scatter to different spots.
    assert sorted(verts_a) != sorted(verts_b)


# ── clearance / detour helpers ────────────────────────────────────────────


def test_motion_clearance_detects_collision():
    tg = crafted_grid(peak=3000.0)
    peak_x, peak_y = 17 * tg.cell, 9 * tg.cell
    start = (2000.0, 2250.0, 800.0)
    vel = ((peak_x - start[0]) / 60.0, (peak_y - start[1]) / 60.0, 0.0)  # ~42 m/s toward peak
    assert not tg.motion_clearance_ok(start, vel, 60.0, TERRAIN_MIN_CLEARANCE)
    # Same trajectory but 2000m higher clears (only 30s out, past the flank).
    high = (start[0], start[1], 800.0 + 2000.0)
    assert tg.motion_clearance_ok(high, vel, 30.0, TERRAIN_MIN_CLEARANCE)


def test_segment_clearance():
    tg = crafted_grid(peak=3000.0)
    peak_x, peak_y = 17 * tg.cell, 9 * tg.cell
    a = (2000.0, 2250.0, 900.0)
    b = (peak_x, peak_y, 900.0)
    assert not tg.segment_clearance_ok(a, b, TERRAIN_MIN_CLEARANCE)
    flat = ((500.0, 500.0, 450.0), (5000.0, 500.0, 450.0))
    assert tg.segment_clearance_ok(*flat, TERRAIN_MIN_CLEARANCE)


def test_detour_waypoint_routes_around_peak():
    tg = crafted_grid(peak=3400.0)
    a = (1500.0, 2250.0, 1400.0)
    b = (7000.0, 2250.0, 1400.0)  # straight line crosses the peak
    wp = tg.detour_waypoint(a, b, 1400.0, TERRAIN_MIN_CLEARANCE)
    assert wp is not None
    assert tg.segment_clearance_ok(a, wp, TERRAIN_MIN_CLEARANCE)
    assert tg.segment_clearance_ok(wp, b, TERRAIN_MIN_CLEARANCE)


def test_no_detour_when_route_is_clear():
    tg = crafted_grid(peak=3400.0)
    a = (500.0, 500.0, 900.0)
    b = (5000.0, 500.0, 900.0)  # low plain
    assert tg.detour_waypoint(a, b, 900.0, TERRAIN_MIN_CLEARANCE) is None


# ── aircraft terrain awareness ────────────────────────────────────────────


def test_cruise_altitude_over_route_clears_crests(real_airspace):
    """Terrain-aware cruise assignment raises en-route altitude above the
    route's tallest crest, instead of riding the TAWS floor along ridges."""
    from backend.simulation.airspace import cruise_altitude_over_route
    from backend.simulation.terrain import CRUISE_TERRAIN_BUFFER

    tg = real_airspace.terrain
    a, b = real_airspace.airports[0], real_airspace.airports[1]
    crest, _ = tg.max_along(a.position, b.position, step=200.0)
    cruise = cruise_altitude_over_route(1800.0, tg, a.position, b.position)
    assert cruise >= crest + CRUISE_TERRAIN_BUFFER - 1e-9
    assert cruise <= real_airspace.ceiling
    # Without terrain the band is kept as-is.
    assert cruise_altitude_over_route(2500.0, None, a.position, b.position) == 2500.0


def test_update_terrain_state_raises_floor():
    tg = crafted_grid(peak=3400.0)
    # Heading straight into the flank of the mountain.
    ac = make_aircraft(tg, x=2000.0, y=2250.0, alt=900.0, hdg=math.radians(90.0))
    ac.update_terrain_state()
    assert ac.terrain_warning
    assert ac.terrain_ahead > 900.0
    target = ac._navigation_target()
    required = ac.terrain_ahead + TERRAIN_MIN_CLEARANCE
    assert target[1] >= required - 5.0  # commanded altitude respects the floor


def test_high_cruise_is_not_flagged():
    tg = crafted_grid(peak=3400.0)
    ac = make_aircraft(tg, x=2000.0, y=2250.0, alt=3900.0, hdg=math.radians(90.0))
    ac.update_terrain_state()
    assert not ac.terrain_warning
    assert ac.terrain_detour is False


def test_overflyable_ridge_selects_climb_not_detour():
    tg = crafted_grid(peak=900.0)  # a shallow ridge, easily out-climbed
    ac = make_aircraft(tg, x=2000.0, y=2250.0, alt=600.0, hdg=math.radians(90.0), fleet_id="fast")
    ac.update_terrain_state()
    assert ac.terrain_warning
    assert ac.terrain_detour is False
    assert ac.terrain_climb_target and ac.terrain_climb_target > 600.0


def test_steep_wall_selects_detour():
    tg = crafted_grid(peak=3400.0)
    ac = make_aircraft(tg, x=2000.0, y=2250.0, alt=900.0, hdg=math.radians(90.0))
    ac.update_terrain_state()
    assert ac.terrain_detour


def test_acl_and_snapshot_fields():
    tg = crafted_grid(peak=3400.0)
    ac = make_aircraft(tg, x=2000.0, y=2250.0, alt=900.0, hdg=math.radians(90.0))
    ac.update_terrain_state()
    snap = ac.snapshot()
    assert snap["agl"] == pytest.approx(700.0, abs=100.0)
    assert "terrain_warning" in snap and "terrain_ahead" in snap


def test_terrain_disabled_by_default():
    a = Airspace()  # no terrain_seed
    assert a.terrain is None
    assert a.terrain_motion_clear((0, 0, 0), (1, 0, 0), 10.0)
    assert a.terrain_detour_waypoint((0, 0, 0), (100, 0, 0), 100.0) is None
    assert "terrain" not in a.snapshot()


def test_initial_fleet_cruise_clears_route_crests(real_airspace):
    """Every spawned fleet aircraft cruises clear of its route's tallest crest,
    so the initial fleet never gets shunted onto a terrain-hugging altitude."""
    import asyncio

    from backend.engine.simulator import SimConfig, Simulator

    sim = Simulator(SimConfig(num_aircraft=24))
    sim._rng.seed(1)
    wired: list = []
    orig = sim._wire_agent
    sim._wire_agent = lambda ac, port=None: wired.append(ac)
    try:
        asyncio.run(sim._spawn_aircraft())
    finally:
        sim._wire_agent = orig

    tg = sim.airspace.terrain
    assert len(wired) == 24
    for ac in wired:
        crest, _ = tg.max_along(ac.position, ac.destination, step=200.0)
        assert ac.cruise_altitude >= crest + CRUISE_TERRAIN_BUFFER - 1e-6, (
            f"{ac.id} cruises {ac.cruise_altitude:.0f} m below crest {crest:.0f} m + buffer"
        )
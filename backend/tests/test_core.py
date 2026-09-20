"""Tests for the SkyMesh backend core (physics, conflict, negotiation, avoidance)."""

from __future__ import annotations

import math
import pytest

from backend.simulation import physics
from backend.simulation.aircraft import Aircraft
from backend.simulation.airspace import Airspace
from backend.simulation.conflict import ConflictDetector
from backend.simulation.negotiation import decide_winner, proposal_consensus_response
from backend.simulation.uncertainty import uncertain_radius


def test_closest_approach_real_crossing():
    a, va = (0.0, 0.0, 500.0), (10.0, 0.0, 0.0)
    b, vb = (500.0, 0.0, 500.0), (-10.0, 0.0, 0.0)
    t, d = physics.closest_approach(a, va, b, vb, horizon=60.0)
    assert t == pytest.approx(25.0)
    assert d == pytest.approx(0.0)


def test_closest_approach_parallel_no_conflict():
    a, va = (0.0, 0.0, 0.0), (10.0, 0.0, 0.0)
    b, vb = (0.0, 2000.0, 0.0), (10.0, 0.0, 0.0)
    t, d = physics.closest_approach(a, va, b, vb, horizon=30.0)
    assert d == pytest.approx(2000.0)


def test_conflict_detector_catches_crossing():
    det = ConflictDetector(horiz_separation=500.0, vert_separation=200.0, horizon=30.0)
    c = det.detect_pair(
        (0.0, 0.0, 1000.0), (100.0, 0.0, 0.0),
        (2000.0, 0.0, 1000.0), (-100.0, 0.0, 0.0),
    )
    assert c is not None
    assert 0 < c.t < 30.0


def test_conflict_detector_allows_time_separated():
    det = ConflictDetector(horiz_separation=500.0, vert_separation=200.0, horizon=30.0)
    c = det.detect_pair(
        (0.0, 0.0, 1000.0), (100.0, 0.0, 0.0),
        (1000.0, -8000.0, 1000.0), (0.0, 100.0, 0.0),
    )
    assert c is None


def test_conflict_detector_vertical_separation_ok():
    det = ConflictDetector(horiz_separation=500.0, vert_separation=200.0, horizon=30.0)
    c = det.detect_pair(
        (0.0, 0.0, 1000.0), (100.0, 0.0, 0.0),
        (2000.0, 0.0, 1500.0), (-100.0, 0.0, 0.0),
    )
    assert c is None


def test_uncertainty_grows_with_age():
    assert uncertain_radius(0.0) == pytest.approx(150.0)
    assert uncertain_radius(10.0) == pytest.approx(150.0 + 40.0 * 10.0)
    assert uncertain_radius(100000.0) <= 5000.0


def test_decide_winner_lower_cost_wins():
    winner = decide_winner("A1", 10.0, 0, 1, "B1", 20.0, 0, 1)
    assert winner == "A1"


def test_decide_winner_priority_wins():
    winner = decide_winner("A1", 99.0, 0, 1, "B1", 1.0, 4, 1)
    assert winner == "B1"


def test_decide_winner_id_tiebreak():
    winner = decide_winner("B11", 5.0, 0, 1, "A01", 5.0, 0, 1)
    assert winner == "A01"


def test_decode_tiebreak_matches_consensus():
    my_id = "A1"
    my_proposal = {"cost": 10.0, "priority": 0, "proposal_version": 2, "sender": my_id}
    incoming = {
        "type": "TRAJECTORY_PROPOSAL",
        "sender": "B1",
        "cost": 5.0,
        "priority": 0,
        "proposal_version": 3,
        "proposal_id": "p-1",
        "maneuver": {"velocity": [1, 0, 0]},
    }
    resp = proposal_consensus_response(my_id, my_proposal, incoming)
    assert resp["type"] == "TRAJECTORY_ACCEPT"
    assert resp["winner"] == "B1"


def test_aircraft_moves_toward_destination():
    ac = Aircraft(
        aircraft_id="T1",
        position=(0.0, 0.0, 1000.0),
        destination=(500.0, 0.0, 1000.0),
        speed=100.0,
        heading=0.0,
        cruise_altitude=1000.0,
    )
    ac.advance(1.0)
    assert ac.position[0] > 0.0
    assert ac.position[1] < 100.0


def test_maneuver_commit_changes_velocity():
    ac = Aircraft("T2", (0, 0, 1000), (1000, 0, 1000), speed=100.0, heading=0.0)
    plan = ac.maneuver_plan(heading_offset=math.radians(90), vertical_rate=0.0)
    ac.commit(plan, comment="turn_left_10")
    v = ac.current_velocity()
    assert abs(v[0]) > 50.0


def test_waypoint_around_returns_none_when_path_clear():
    airspace = Airspace()
    airspace.add_obstacle("NO_FLY", (3000.0, 0.0, 1000.0), 1000.0, 2000.0)
    wp = airspace.waypoint_around((0.0, 0.0, 1000.0), (0.0, 5000.0, 1000.0), clearance=300.0)
    assert wp is None


def test_waypoint_around_routes_around_obstacle():
    airspace = Airspace()
    airspace.add_obstacle("STORM", (0.0, 2500.0, 1000.0), 1000.0, 2000.0)
    wp = airspace.waypoint_around((0.0, 0.0, 1000.0), (0.0, 5000.0, 1000.0), clearance=300.0)
    assert wp is not None
    R = 1000.0 + 300.0
    assert math.hypot(wp[0] - 0.0, wp[1] - 2500.0) >= R - 1.0


def test_aircraft_avoids_obstacle_via_waypoint():
    airspace = Airspace()
    airspace.add_obstacle("STORM", (0.0, 2500.0, 1000.0), 1000.0, 2000.0)
    ac = Aircraft(
        aircraft_id="W1",
        position=(0.0, 0.0, 1000.0),
        destination=(0.0, 5000.0, 1000.0),
        speed=100.0,
        heading=0.0,
        cruise_altitude=1000.0,
    )
    min_dist = float("inf")
    for _ in range(300):
        if not ac.reached_destination():
            ac.waypoint = airspace.waypoint_around(ac.position, ac.destination, 300.0)
        else:
            ac.waypoint = None
        ac.advance(0.1)
        d = math.hypot(ac.position[0], ac.position[1] - 2500.0)
        min_dist = min(min_dist, d)
    assert min_dist >= 1000.0 + 300.0 - 80.0


def test_airports_defaulted_to_six_open_fields():
    airspace = Airspace()
    assert len(airspace.airports) == 6
    assert all(not a.closed for a in airspace.airports)
    assert airspace.snapshot()["airports"][0]["name"]


def test_random_airport_excludes_closed_and_self():
    airspace = Airspace()
    airspace.airports[0].closed = True
    for _ in range(50):
        picked = airspace.random_airport()
        assert picked.aid != airspace.airports[0].aid

    first = airspace.random_airport(exclude_id="APT1")
    assert first.aid != "APT1"


def test_close_airport_marks_one_closed():
    airspace = Airspace()
    closed = airspace.close_airport()
    assert closed is not None
    assert closed.closed is True
    assert sum(1 for a in airspace.airports if a.closed) == 1


def test_aircraft_descends_into_low_airport_nearby():
    ac = Aircraft(
        aircraft_id="L1",
        position=(1000.0, 1000.0, 2000.0),
        destination=(1200.0, 1000.0, 140.0),
        speed=100.0,
        heading=0.0,
        cruise_altitude=2000.0,
    )
    v = ac.steer_velocity()
    assert v[2] < 0.0, "should descend into a nearby low destination"


def test_aircraft_holds_cruise_when_far_from_airport():
    ac = Aircraft(
        aircraft_id="L2",
        position=(1000.0, 1000.0, 2000.0),
        destination=(9000.0, 9000.0, 140.0),
        speed=100.0,
        heading=0.0,
        cruise_altitude=2000.0,
    )
    v = ac.steer_velocity()
    assert v[2] == pytest.approx(0.0, abs=25.0), "cruises at altitude far from the airport"


def test_aircraft_descends_without_waypoint_only():
    ac = Aircraft(
        aircraft_id="L3",
        position=(1000.0, 1000.0, 2000.0),
        destination=(1100.0, 1000.0, 140.0),
        speed=100.0,
        heading=0.0,
        cruise_altitude=2000.0,
    )
    ac.waypoint = (5000.0, 5000.0, 2000.0)
    assert ac.steer_velocity()[2] >= -25.0, "avoidance waypoint overrides descent"


def test_maneuver_plan_expires_and_clears():
    ac = Aircraft("T3", (0, 0, 1000), (1000, 0, 1000), speed=100.0, heading=0.0)
    ac.commit(ac.maneuver_plan(heading_offset=0.0, vertical_rate=100.0), comment="climb")
    assert ac.current_velocity()[2] == pytest.approx(100.0)
    ac.advance(1.0)
    assert ac.plan is not None
    ac.advance(1.0)
    assert ac.plan is not None
    ac.advance(1.0)
    assert ac.plan is None, "committed plan must clear once its duration elapses"
    assert ac.current_velocity()[2] >= -25.0, "steering resumes after the maneuver ends"


def test_cruise_altitudes_fall_in_discrete_bands():
    from backend.simulation.airspace import ALTITUDE_BANDS, random_cruise_altitude

    for _ in range(200):
        a = random_cruise_altitude()
        assert any(abs(a - b) <= 150.0 for b in ALTITUDE_BANDS), a


def test_snapshot_includes_route_and_progress():
    ac = Aircraft(
        aircraft_id="R1",
        position=(1000.0, 1000.0, 2000.0),
        destination=(1200.0, 1000.0, 140.0),
        speed=100.0,
        cruise_altitude=2000.0,
    )
    ac.origin_aid = "APT1"
    ac.dest_aid = "APT2"
    ac.leg_distance = 20000.0
    ac.leg_travelled = 10000.0
    s = ac.snapshot()
    assert s["origin_aid"] == "APT1"
    assert s["dest_aid"] == "APT2"
    assert s["state"] in ("landing", "cruise", "held")
    assert s["progress"] == pytest.approx(0.5)


def test_snapshot_state_held_when_parked_at_runway():
    ac = Aircraft("R2", (500, 500, 140), (500, 500, 140), speed=0.0, cruise_altitude=2000.0)
    ac.held = True
    assert ac.snapshot()["state"] == "held"


# ---------------------------------------------------------------------------
# Flight phases, runways, and the terminal controller
# ---------------------------------------------------------------------------

from backend.simulation.aircraft import (  # noqa: E402
    ARRIVAL_PHASES,
    BASE,
    CLIMB,
    CLIMBOUT,
    CRUISE,
    DEPARTURE_PHASES,
    DESCENT,
    DOWNWIND,
    FINAL,
    FLARE,
    GO_AROUND,
    GROUND_PHASES,
    LINE_UP,
    PARKED,
    ROLLOUT,
    TAKEOFF,
    TAXI_IN,
    TAXI_OUT,
)
from backend.simulation.fleet import (  # noqa: E402
    REGIONAL,
    TAXI_SPEED,
    TYPES,
    WAKE_HEAVY,
    WAKE_LIGHT,
    WAKE_MEDIUM,
)
from backend.terminal.sequencer import (  # noqa: E402
    TerminalController,
    departure_gap,
    wake_gap,
)


def test_phase_envelopes_cover_every_phase():
    all_phases = {
        PARKED, TAXI_OUT, LINE_UP, TAKEOFF, CLIMBOUT, CLIMB, CRUISE,
        DESCENT, DOWNWIND, BASE, FINAL, FLARE, ROLLOUT, TAXI_IN, GO_AROUND,
    }
    assert GROUND_PHASES | ARRIVAL_PHASES | DEPARTURE_PHASES == all_phases - {CRUISE}
    assert CRUISE in all_phases


def test_wake_gap_table():
    assert wake_gap(WAKE_LIGHT, WAKE_HEAVY) == 240.0
    assert wake_gap(WAKE_MEDIUM, WAKE_HEAVY) == 180.0
    assert wake_gap(WAKE_HEAVY, WAKE_HEAVY) == 150.0
    assert wake_gap(WAKE_LIGHT, WAKE_MEDIUM) == 150.0
    assert wake_gap(WAKE_MEDIUM, WAKE_MEDIUM) == 120.0
    assert wake_gap(WAKE_LIGHT, WAKE_LIGHT) == 120.0


def test_departure_gap_table():
    assert departure_gap(WAKE_LIGHT, WAKE_HEAVY) == 150.0
    assert departure_gap(WAKE_MEDIUM, WAKE_HEAVY) == 120.0
    assert departure_gap(WAKE_HEAVY, WAKE_HEAVY) == 120.0
    assert departure_gap(WAKE_LIGHT, WAKE_MEDIUM) == 90.0
    assert departure_gap(WAKE_MEDIUM, WAKE_MEDIUM) == 60.0


def test_terminal_sequences_arrivals_by_wake_gap():
    t = TerminalController()
    t1 = t.request_final("A1", "RW", WAKE_LIGHT, eta=100.0, now=50.0)
    assert t1 == pytest.approx(100.0)
    t2 = t.request_final("A2", "RW", WAKE_LIGHT, eta=120.0, now=50.0)
    assert t2 == pytest.approx(100.0 + wake_gap(WAKE_LIGHT, WAKE_LIGHT))
    assert t.slot_open("A2", "RW", now=120.0) is False
    assert t.slot_open("A2", "RW", now=220.0) is True


def test_terminal_heavy_gap_pushes_light_traffic_back():
    t = TerminalController()
    t.request_final("H1", "RW", WAKE_HEAVY, eta=100.0, now=0.0)
    o = t.request_final("L1", "RW", WAKE_LIGHT, eta=115.0, now=0.0)
    assert o == pytest.approx(100.0 + 240.0)


def test_terminal_go_around_reenters_ahed():
    t = TerminalController()
    t.request_final("A0", "RW", WAKE_LIGHT, eta=100.0, now=0.0)
    o = t.request_go_around("A0", "RW", WAKE_LIGHT, eta=0.0, now=50.0)
    assert o == pytest.approx(50.0)
    aborted = [s for s in t.slots("RW") if s["status"] == "aborted"]
    pending = [s for s in t.slots("RW") if s["status"] == "pending"]
    assert len(aborted) == 1
    assert len(pending) == 1
    assert pending[0]["open_at"] == pytest.approx(50.0)
    assert t.slot_open("A0", "RW", now=50.0) is True


def test_clear_for_departure_gated_by_arrivals_and_departure_gap():
    t = TerminalController()
    t.request_final("A1", "RW", WAKE_LIGHT, eta=100.0, now=0.0)
    # A departure now would still be rolling as A1 reaches the threshold.
    assert t.clear_for_departure("D1", "RW", WAKE_MEDIUM, now=0.0) is False
    # Once the arrival lands and clears the runway, departures may start...
    t.note_landed("A1", "RW", now=150.0)
    assert t.clear_for_departure("D2", "RW", WAKE_MEDIUM, now=250.0) is True
    # ...but consecutive rollouts respect the departure gap.
    assert t.clear_for_departure("D3", "RW", WAKE_MEDIUM, now=251.0) is False


def test_landing_blocked_while_runway_busy():
    t = TerminalController()
    t.note_landed("A1", "RW", now=100.0)
    assert t.landing_blocked("A2", "RW", now=150.0) is True
    assert t.landing_blocked("A2", "RW", now=190.0) is False


def test_aircraft_full_departure_sequence():
    airspace = Airspace()
    dep = airspace.airports[0]
    dest = airspace.airports[1]
    rw = dep.active_runway()
    ac = Aircraft(
        "D1",
        rw.departure_point(),
        destination=dest.position,
        speed=0.0,
        cruise_altitude=1500.0,
        fleet=TYPES[REGIONAL],
    )
    ac.dep_runway = rw
    ac.runway = rw
    ac.phase = TAXI_OUT
    phases: set[str] = set()
    for _ in range(6000):
        phases.add(ac.phase)
        if ac.phase == LINE_UP:
            ac.line_up_cleared = True
        ac.advance(1.0)
        if ac.phase == CRUISE:
            break
    assert {"taxi_out", "line_up", "takeoff", "climbout", "climb"} <= phases
    assert ac.phase == CRUISE
    assert ac.position[2] >= ac.cruise_altitude - 25.0


def test_aircraft_descent_enters_downwind_near_runway():
    airspace = Airspace()
    apt = airspace.airports[1]
    rw = apt.active_runway()
    t = TYPES[REGIONAL]
    ac = Aircraft(
        "A1",
        rw.downwind_entry(t),
        destination=apt.position,
        speed=t.descend_speed,
        cruise_altitude=1800.0,
        fleet=t,
    )
    ac.runway = rw
    ac.dest_airport = apt
    ac.phase = DESCENT
    ac.advance(1.0)
    assert ac.phase == DOWNWIND
    assert ac.join_final is False


def test_aircraft_go_around_rejoins_pattern():
    airspace = Airspace()
    apt = airspace.airports[1]
    rw = apt.active_runway()
    t = TYPES[REGIONAL]
    ac = Aircraft(
        "G1",
        rw.downwind_entry(t),
        destination=apt.position,
        speed=t.approach_speed,
        cruise_altitude=1800.0,
        fleet=t,
    )
    ac.runway = rw
    ac.dest_airport = apt
    ac.phase = FINAL
    ac.go_around = True
    ac.advance(1.0)
    assert ac.phase == GO_AROUND
    ac.advance(1.0)
    assert ac.phase == DOWNWIND
    assert ac.go_around is False


def test_final_approach_descends_to_glideslope():
    airspace = Airspace()
    apt = airspace.airports[1]
    rw = apt.active_runway()
    t = TYPES[REGIONAL]
    ux, uy = rw.u
    thr = rw.threshold
    # 8 km out on the extended centerline, 500 m above the 3° glideslope.
    px = thr[0] - ux * 8000.0
    py = thr[1] - uy * 8000.0
    ac = Aircraft(
        "F1",
        (px, py, rw.elevation + 500.0),
        destination=apt.position,
        speed=t.approach_speed,
        cruise_altitude=1800.0,
        fleet=t,
    )
    ac.runway = rw
    ac.dest_airport = apt
    ac.phase = FINAL
    ac.heading = rw.heading
    assert ac._final_alt() < ac.position[2]
    assert ac.steer_velocity()[2] < 0.0


def test_rollout_transitions_to_taxi_in():
    airspace = Airspace()
    apt = airspace.airports[0]
    rw = apt.active_runway()
    ac = Aircraft(
        "R1",
        rw.threshold,
        destination=apt.position,
        speed=0.0,
        cruise_altitude=1500.0,
        fleet=TYPES[REGIONAL],
    )
    ac.runway = rw
    ac.dep_runway = rw
    ac.phase = ROLLOUT
    ac.speed = TAXI_SPEED * 2.0
    for _ in range(20):
        ac.advance(1.0)
        if ac.phase == TAXI_IN:
            break
    assert ac.phase == TAXI_IN
    assert ac.speed > 0.0


def test_full_landing_over_terrain_reaches_parked():
    """With terrain enabled a final-approach aircraft still lands and parks.

    Guards the terrain-clearance floor in `_nav` from stalling the descent
    (final/flare are exempt) and the formerly-missing rollout → taxi-in link.
    """
    airspace = Airspace(terrain_seed=1337)
    apt = airspace.airports[1]
    rw = apt.active_runway()
    t = TYPES[REGIONAL]
    ux, uy = rw.u
    thr = rw.threshold
    px = thr[0] - ux * 8000.0
    py = thr[1] - uy * 8000.0
    ac = Aircraft(
        "T1",
        (px, py, rw.elevation + 500.0),
        destination=apt.position,
        speed=t.approach_speed,
        cruise_altitude=1800.0,
        fleet=t,
    )
    ac.terrain = airspace.terrain
    ac.runway = rw
    ac.dest_airport = apt
    ac.phase = FINAL
    ac.heading = rw.heading
    for _ in range(4000):
        if ac.phase == PARKED:
            break
        ac.advance(1.0)
    assert ac.phase == PARKED
    assert ac.position[2] == pytest.approx(apt.position[2], abs=100.0)


def test_active_runway_favours_headwind():
    airspace = Airspace()
    apt = airspace.airports[0]
    apt._ensure_runways()
    r1, r2 = apt.runways
    eastward = (7.0, 0.0, 0.0)
    assert r2.into_wind_rating(eastward) > r1.into_wind_rating(eastward)
    assert apt.active_runway(eastward).rid == r2.rid
    westward = (-7.0, 0.0, 0.0)
    assert apt.active_runway(westward).rid == r1.rid


def test_airport_snapshot_includes_runways_and_hub():
    airspace = Airspace()
    apt = airspace.airports[0]
    s = apt.snapshot()
    assert s["hub"] is True
    assert len(s["runways"]) >= 2
    assert all(r["id"] and r["heading_label"] and r["length"] > 0 for r in s["runways"])


def test_aircraft_snapshot_exposes_phase_and_runways():
    airspace = Airspace()
    apt = airspace.airports[0]
    rw = apt.active_runway()
    ac = Aircraft(
        "S1",
        rw.threshold,
        destination=apt.position,
        speed=0.0,
        cruise_altitude=1500.0,
        fleet=TYPES[REGIONAL],
    )
    ac.runway = rw
    ac.dep_runway = rw
    ac.phase = ROLLOUT
    s = ac.snapshot()
    assert s["phase"] == ROLLOUT
    assert s["type"] == TYPES[REGIONAL].name
    assert s["wake"] == TYPES[REGIONAL].wake
    assert s["runway"] == rw.rid
    assert s["dep_runway"] == rw.rid
    assert s["state"] == "held"
"""Tests for the SkyMesh backend core (physics, conflict, negotiation)."""

from __future__ import annotations

import math
import pytest

from backend.simulation import physics
from backend.simulation.aircraft import Aircraft
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
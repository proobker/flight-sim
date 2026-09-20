"""Candidate maneuver generation and safety filtering.

When a conflict is detected, an aircraft samples a small set of discrete
alternative velocity vectors (turn/climb/descend/speed). Each candidate is
checked against known neighbors, uncertain silent peers, obstacles and the
airspace bounds; unsafe candidates are discarded.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from . import physics
from .aircraft import Plan


@dataclass
class Candidate:
    name: str
    plan: Plan
    cost: float = math.inf
    safe: bool = True
    reasons: list[str] = field(default_factory=list)


def generate_candidates(aircraft, airspace, detector) -> list[Candidate]:
    cands: list[Candidate] = []

    def vel(heading_offset: float, speed_factor: float, vz: float) -> tuple[float, float, float]:
        return physics.to_velocity(
            aircraft.heading + heading_offset, aircraft.speed * speed_factor, vz
        )

    options = [
        ("straight", 0.0, 1.0, 0.0),
        ("turn_left_10", -math.radians(10), 1.0, 0.0),
        ("turn_right_10", math.radians(10), 1.0, 0.0),
        ("turn_left_18", -math.radians(18), 1.0, 0.0),
        ("turn_right_18", math.radians(18), 1.0, 0.0),
        ("climb", 0.0, 1.0, aircraft.climb_rate),
        ("descend", 0.0, 1.0, -aircraft.climb_rate),
        ("slow", 0.0, 0.8, 0.0),
        ("climb_left", -math.radians(10), 1.0, aircraft.climb_rate),
        ("climb_right", math.radians(10), 1.0, aircraft.climb_rate),
        ("fast", 0.0, 1.25, 0.0),
    ]
    for name, off, sf, vz in options:
        cands.append(
            Candidate(
                name=name,
                plan=Plan(
                    velocity=vel(off, sf, vz),
                    duration=aircraft.maneuver_duration,
                    comment=name,
                ),
            )
        )
    return cands


def filter_candidates(
    candidates: list[Candidate],
    self_pos: tuple[float, float, float],
    neighbors: list[Any],
    uncertain_neighbors: list[Any],
    airspace,
    detector,
    obstacles_active: bool = True,
) -> list[Candidate]:
    """Mark candidates safe/unsafe and compute approximate costs."""
    safe: list[Candidate] = []
    for cand in candidates:
        reasons: list[str] = []
        ok = True

        end = physics.advance(self_pos, cand.plan.velocity, cand.plan.duration)
        end = airspace.enforce_bounds(end)
        if not airspace.in_bounds(end):
            ok = False
            reasons.append("out-of-bounds")

        for nb in neighbors:
            c = detector.detect_pair(self_pos, cand.plan.velocity, nb.position, nb.velocity)
            if c is not None:
                ok = False
                reasons.append(f"conflict-{nb.aircraft_id}")
                break

        for unc in uncertain_neighbors:
            c = detector.detect_against_uncertainty(
                self_pos, cand.plan.velocity, unc.aircraft_id, unc.position, unc.uncertain_radius, unc.altitude_envelope
            )
            if c is not None:
                ok = False
                reasons.append(f"uncertain-{unc.aircraft_id}")
                break

        if ok and obstacles_active:
            for obs in airspace.obstacles_between(self_pos, end, obstacle_clearance=300.0):
                ok = False
                reasons.append(f"obstacle-{obs.obs_id}")
                break

        if ok and airspace is not None:
            from .terrain import TERRAIN_MIN_CLEARANCE

            if not airspace.terrain_motion_clear(self_pos, cand.plan.velocity, cand.plan.duration, TERRAIN_MIN_CLEARANCE):
                ok = False
                reasons.append("terrain")

        cand.reasons = reasons
        cand.safe = ok
        if ok:
            safe.append(cand)
    return safe
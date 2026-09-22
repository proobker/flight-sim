"""Maneuver cost function.

cost = deviation * deviation_weight * priority_factor
     + delay_penalty
     + maneuver_complexity
     + risk_penalty

Emergency aircraft pay a fraction of the deviation penalty so they keep their
route: cost of route deviation × emergency_factor.
"""

from __future__ import annotations

import math


def candidate_cost(candidate, aircraft, **kwargs) -> float:
    return plan_cost(candidate.plan, aircraft, **kwargs)


def plan_cost(plan, aircraft, *, deviation_weight: float = 1.0, delay_weight: float = 0.15,
              complexity_weight: float = 0.4, risk_weight: float = 0.3,
              emergency_factor: float = 0.4) -> float:
    v = plan.velocity
    speed = (v[0] ** 2 + v[1] ** 2) ** 0.5
    heading_rate = 0.0
    if speed > 0:
        heading = math.atan2(v[0], v[1])
        heading_rate = abs(_angdiff(heading, aircraft.heading))

    deviation = heading_rate
    ref_climb = max(getattr(aircraft, "climb_rate", 1.0), 1e-6)
    if abs(v[2]) > 1:
        deviation += abs(v[2]) / ref_climb * 0.5
    ref_speed = max(aircraft.speed, 1e-6)
    if speed < ref_speed * 0.95:
        deviation += (ref_speed - speed) / ref_speed * 1.0
    elif speed > ref_speed * 1.05:
        deviation += (speed - ref_speed) / ref_speed * 1.2

    multiplier = emergency_factor if aircraft.emergency else 1.0
    cost = (
        deviation * deviation_weight * multiplier
        + _complexity(str(getattr(plan, "comment", ""))) * complexity_weight
        + risk_weight * (1.0 if "fast" in str(getattr(plan, "comment", "")) else 0.0)
        + delay_weight * _ordering_bias(str(getattr(plan, "comment", "")))
    )
    return round(cost, 3)


def _complexity(name: str) -> float:
    base = {"straight": 0.0, "slow": 0.5, "fast": 0.6}.get(name, 1.0)
    return base


def _ordering_bias(name: str) -> float:
    order = ["straight", "slow", "climb", "descend", "climb_left", "climb_right",
             "turn_left_10", "turn_right_10", "turn_left_18", "turn_right_18", "fast"]
    try:
        return order.index(name) * 0.1
    except ValueError:
        return 0.5


def _angdiff(a: float, b: float) -> float:
    d = (a - b + math.pi) % (2 * math.pi) - math.pi
    return abs(d)
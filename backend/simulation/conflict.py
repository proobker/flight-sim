"""4D conflict detection — X, Y, Z and time.

A conflict exists when two predicted trajectories violate an ellipsoidal
separation region (horizontal H, vertical V) sometime within the prediction
horizon, or when either trajectory enters an uncertain region that has grown
around a silent peer.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import physics


@dataclass
class Conflict:
    other_id: str
    t: float
    distance: float
    predicted_point: tuple[float, float, float]
    against_uncertain: bool = False
    uncertain_radius: float = 0.0


class ConflictDetector:
    def __init__(
        self,
        horiz_separation: float = 1000.0,
        vert_separation: float = 300.0,
        horizon: float = 30.0,
    ) -> None:
        self.horiz_separation = horiz_separation
        self.vert_separation = vert_separation
        self.horizon = horizon

    def detect_pair(
        self,
        self_pos: tuple[float, float, float],
        self_vel: tuple[float, float, float],
        other_pos: tuple[float, float, float],
        other_vel: tuple[float, float, float],
    ) -> Conflict | None:
        t, dist = physics.closest_approach(self_pos, self_vel, other_pos, other_vel, self.horizon)
        if t <= 0 and physics.distance(self_pos, other_pos) > self.horiz_separation:
            return None
        p1 = physics.advance(self_pos, self_vel, t)
        p2 = physics.advance(other_pos, other_vel, t)
        if physics.h_distance(p1, p2) < self.horiz_separation and abs(p1[2] - p2[2]) < self.vert_separation:
            midpoint = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2)
            return Conflict(other_id="", t=t, distance=dist, predicted_point=midpoint)
        return None

    def detect_against_uncertainty(
        self,
        self_pos: tuple[float, float, float],
        self_vel: tuple[float, float, float],
        other_id: str,
        other_pos: tuple[float, float, float],
        uncertain_radius: float,
        altitude_envelope: float,
    ) -> Conflict | None:
        t, dist = physics.closest_approach(self_pos, self_vel, other_pos, (0.0, 0.0, 0.0), self.horizon)
        p = physics.advance(self_pos, self_vel, t)
        if physics.h_distance(p, other_pos) < uncertain_radius and abs(p[2] - other_pos[2]) < altitude_envelope:
            return Conflict(
                other_id=other_id,
                t=t,
                distance=dist,
                predicted_point=p,
                against_uncertain=True,
                uncertain_radius=uncertain_radius,
            )
        return None
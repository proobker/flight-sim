"""4D conflict detection — X, Y, Z and time.

A conflict exists when two predicted trajectories violate an ellipsoidal
separation region (horizontal H, vertical V) sometime within the prediction
horizon, or when either trajectory enters an uncertain region that has grown
around a silent peer.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import physics
from .airspace import TERMINAL_RADIUS


@dataclass
class Conflict:
    other_id: str
    t: float
    distance: float
    predicted_point: tuple[float, float, float]
    against_uncertain: bool = False
    uncertain_radius: float = 0.0


class ConflictDetector:
    """4D conflict detection — with tiered separation standards.

    Inside an airport terminal area (TERMINAL_RADIUS) the horizontal
    standard tightens (3 km, roughly 3 NM on final) vs the en-route 5 km.
    The vertical standard stays 300 m either way. When no airspace is
    attached the configured values are used verbatim.
    """

    def __init__(
        self,
        horiz_separation: float = 5000.0,
        vert_separation: float = 300.0,
        horizon: float = 90.0,
        airspace=None,
        terminal_horiz: float = 3000.0,
    ) -> None:
        self.horiz_separation = horiz_separation
        self.vert_separation = vert_separation
        self.terminal_horiz = terminal_horiz
        self.horizon = horizon
        self.airspace = airspace

    def _separations(self, pos) -> tuple[float, float]:
        if self.airspace is None:
            return self.horiz_separation, self.vert_separation
        for a in self.airspace.airports:
            if physics.h_distance(pos, a.position) < TERMINAL_RADIUS:
                return self.terminal_horiz, self.vert_separation
        return self.horiz_separation, self.vert_separation

    def detect_pair(
        self,
        self_pos: tuple[float, float, float],
        self_vel: tuple[float, float, float],
        other_pos: tuple[float, float, float],
        other_vel: tuple[float, float, float],
    ) -> Conflict | None:
        t, dist = physics.closest_approach(self_pos, self_vel, other_pos, other_vel, self.horizon)
        p1 = physics.advance(self_pos, self_vel, t)
        p2 = physics.advance(other_pos, other_vel, t)
        mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2)
        hz, vt = self._separations(mid)
        if t <= 0 and physics.distance(self_pos, other_pos) > hz:
            return None
        if physics.h_distance(p1, p2) < hz and abs(p1[2] - p2[2]) < vt:
            return Conflict(other_id="", t=t, distance=dist, predicted_point=mid)
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
        hz, vt = self._separations(p)
        if physics.h_distance(p, other_pos) < min(uncertain_radius, hz) and abs(p[2] - other_pos[2]) < min(altitude_envelope, vt):
            return Conflict(
                other_id=other_id,
                t=t,
                distance=dist,
                predicted_point=p,
                against_uncertain=True,
                uncertain_radius=uncertain_radius,
            )
        return None
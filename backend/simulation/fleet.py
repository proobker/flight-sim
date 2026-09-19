"""Aircraft fleet — performance profiles and wake-turbulence categories.

Each aircraft is assigned an AircraftType when it spawns. The type governs
every speed/rate the aircraft is allowed to fly, so turns, climbs, descents,
takeoff rolls and final approaches all obey real-ish performance envelopes.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

WAKE_LIGHT = "LIGHT"
WAKE_MEDIUM = "MEDIUM"
WAKE_HEAVY = "HEAVY"

GA = "GA"
REGIONAL = "REGIONAL"
NARROW = "NARROW"
WIDEBODY = "WIDEBODY"

TAXI_SPEED = 7.0


@dataclass(frozen=True)
class AircraftType:
    """Performance envelope for one category of aircraft."""

    name: str
    wake: str
    min_speed: float  # m/s
    max_speed: float  # m/s
    cruise_speed: float  # m/s
    climb_speed: float  # m/s during climb
    descend_speed: float  # m/s during descent
    approach_speed: float  # m/s caught on final
    climb_rate: float  # m/s vertical
    descend_rate: float  # m/s vertical
    turn_rate: float  # rad/s (~17°/s → 0.30)
    acceleration: float  # m/s^2 horizontal (takeoff / speed changes)
    braking: float  # m/s^2 deceleration on rollout / taxi
    pattern_offset: float  # m from runway centerline to the downwind leg
    pattern_alt_agl: float  # m the downwind/base legs hold above field elev.
    downwind_len: float  # m the downwind leg extends past the departure end
    final_len: float  # m straight on centerline before the threshold
    roll_len: float  # m rollout after touchdown before slow taxi

    @property
    def rotate_speed(self) -> float:
        """Approx rotation speed — brisk, so takeoff rolls fit real runways."""
        return self.approach_speed * 0.72

    def fly_speed(self, phase: str) -> float:
        """Target horizontal speed for a flight phase."""
        if phase in ("climbout", "climb"):
            return self.climb_speed
        if phase in ("descent", "downwind"):
            return self.descend_speed
        if phase in ("base",):
            return self.approach_speed
        if phase in ("final",):
            return self.approach_speed * 0.9
        if phase == "takeoff":
            return self.climb_speed
        if phase == "cruise":
            return self.cruise_speed
        return self.approach_speed


TYPES: dict[str, AircraftType] = {
    GA: AircraftType(
        name="GA", wake=WAKE_LIGHT,
        min_speed=35.0, max_speed=85.0, cruise_speed=72.0,
        climb_speed=62.0, descend_speed=55.0, approach_speed=42.0,
        climb_rate=5.0, descend_rate=4.0, turn_rate=0.45,
        acceleration=2.4, braking=2.6,
        pattern_offset=1600.0, pattern_alt_agl=450.0, downwind_len=7500.0,
        final_len=6000.0, roll_len=900.0,
    ),
    REGIONAL: AircraftType(
        name="REGIONAL", wake=WAKE_MEDIUM,
        min_speed=55.0, max_speed=145.0, cruise_speed=130.0,
        climb_speed=115.0, descend_speed=100.0, approach_speed=62.0,
        climb_rate=8.0, descend_rate=6.0, turn_rate=0.30,
        acceleration=1.6, braking=1.9,
        pattern_offset=2400.0, pattern_alt_agl=600.0, downwind_len=11000.0,
        final_len=8500.0, roll_len=1100.0,
    ),
    NARROW: AircraftType(
        name="NARROW", wake=WAKE_MEDIUM,
        min_speed=60.0, max_speed=250.0, cruise_speed=215.0,
        climb_speed=180.0, descend_speed=155.0, approach_speed=72.0,
        climb_rate=18.0, descend_rate=12.0, turn_rate=0.22,
        acceleration=1.2, braking=1.5,
        pattern_offset=3000.0, pattern_alt_agl=700.0, downwind_len=14000.0,
        final_len=9500.0, roll_len=1400.0,
    ),
    WIDEBODY: AircraftType(
        name="WIDEBODY", wake=WAKE_HEAVY,
        min_speed=65.0, max_speed=260.0, cruise_speed=238.0,
        climb_speed=195.0, descend_speed=170.0, approach_speed=78.0,
        climb_rate=16.0, descend_rate=11.0, turn_rate=0.12,
        acceleration=1.0, braking=1.3,
        pattern_offset=3800.0, pattern_alt_agl=700.0, downwind_len=16000.0,
        final_len=10000.0, roll_len=1600.0,
    ),
}

# Higher weight = more common at a random medium-busy field.
SPAWN_WEIGHTS = [("WIDEBODY", 1), ("NARROW", 4), ("REGIONAL", 4), ("GA", 3)]
# A hub airport skews toward transports.
HUB_WEIGHTS = [("WIDEBODY", 3), ("NARROW", 5), ("REGIONAL", 2), ("GA", 1)]


def assign_type(rng: random.Random, hub: bool = False) -> AircraftType:
    table = HUB_WEIGHTS if hub else SPAWN_WEIGHTS
    names = [n for n, _ in table]
    weights = [w for _, w in table]
    return TYPES[rng.choices(names, weights=weights, k=1)[0]]
"""Uncertainty around silent aircraft.

A node that stops broadcasting is not deleted. It remains in the local world
model as an uncertain moving object: its last-known position expands into a
region whose horizontal radius grows linearly with silence time. Other
aircraft treat that region as an obstacle they must stay clear of.
"""

from __future__ import annotations


def uncertain_radius(age: float, base: float = 150.0, growth_per_sec: float = 40.0, max_radius: float = 5000.0) -> float:
    return min(max_radius, base + growth_per_sec * age)


def uncertain_altitude(age: float, base: float = 200.0, growth_per_sec: float = 15.0, max_alt: float = 6000.0) -> float:
    return min(max_alt, base + growth_per_sec * age)


class SilentRegion:
    """A single silent peer's uncertainty region as seen by one observer."""

    def __init__(
        self,
        other_id: str,
        last_position: tuple[float, float, float],
        age: float = 0.0,
    ) -> None:
        self.other_id = other_id
        self.position = last_position
        self.age = age

    @property
    def aircraft_id(self) -> str:
        return self.other_id

    @property
    def uncertain_radius(self) -> float:
        return uncertain_radius(self.age)

    @property
    def altitude_envelope(self) -> float:
        return uncertain_altitude(self.age)
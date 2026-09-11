"""Aircraft node — local state, planner state, movement.

An aircraft free-flies toward its destination when not constrained, and
executes a committed maneuver (fixed velocity vector for a duration) when
negotiating around a conflict.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from . import physics

PRIORITY_EMERGENCY = 4
PRIORITY_MEDICAL = 3
PRIORITY_PASSENGER = 2
PRIORITY_CARGO = 1
PRIORITY_NORMAL = 0


@dataclass
class Plan:
    """A fixed velocity the aircraft commits to flying for `duration` seconds."""

    velocity: tuple[float, float, float]
    duration: float
    version: int = 0
    comment: str = ""


class Aircraft:
    def __init__(
        self,
        aircraft_id: str,
        position: tuple[float, float, float],
        destination: tuple[float, float, float],
        speed: float = 160.0,
        heading: float = 0.0,
        priority: int = PRIORITY_NORMAL,
        cruise_altitude: float = 1500.0,
        climb_rate: float = 25.0,
        min_altitude: float = 100.0,
        max_altitude: float = 6000.0,
        turn_rate: float = 0.30,
        maneuver_duration: float = 3.0,
        cooldown: float = 2.0,
        approach_radius: float = 4000.0,
        approach_altitude_offset: float = 60.0,
    ) -> None:
        self.id = aircraft_id
        self.position = position
        self.destination = destination
        self.waypoint: tuple[float, float, float] | None = None
        self.speed = speed
        self.priority = priority
        self.cruise_altitude = cruise_altitude
        self.climb_rate = climb_rate
        self.min_altitude = min_altitude
        self.max_altitude = max_altitude
        self.turn_rate = turn_rate
        self.maneuver_duration = maneuver_duration
        self.cooldown_duration = cooldown
        self.approach_radius = approach_radius
        self.approach_altitude_offset = approach_altitude_offset

        self.heading = heading
        self.active = True
        self.emergency = False
        self.held = False
        self.origin_aid: str | None = None
        self.dest_aid: str | None = None
        self.leg_distance = 1.0
        self.leg_travelled = 0.0

        self.trajectory_version = 0
        self.plan: Plan | None = None
        self.pending_plan: Plan | None = None
        self.proposal_pending_to: str | None = None
        self.proposed_version: int = -1
        self.cooldown_until: float = 0.0
        self.last_commit_at: float = float("-inf")

        self.distance_travelled = 0.0
        self.fuel_used = 0.0
        self.conflicts_generated = 0
        self.conflicts_resolved = 0

    # ----- movement -----
    def advance(self, dt: float) -> None:
        if not self.active:
            return
        velocity = self.current_velocity()
        self.position = physics.advance(self.position, velocity, dt)
        h_speed = math.hypot(velocity[0], velocity[1])
        self.distance_travelled += h_speed * dt
        self.leg_travelled += h_speed * dt
        self.fuel_used += h_speed * dt / 1000.0
        self.heading = math.atan2(velocity[0], velocity[1])
        if self.plan is not None:
            self.plan.duration = max(0.0, self.plan.duration - dt)
            if self.plan.duration <= 0.0:
                self.plan = None

    def current_velocity(self) -> tuple[float, float, float]:
        if self.plan is not None and self.plan.duration > 0:
            return self.plan.velocity
        return self.steer_velocity()

    def steer_velocity(self) -> tuple[float, float, float]:
        target = self.waypoint if self.waypoint is not None else self.destination
        dx = target[0] - self.position[0]
        dy = target[1] - self.position[1]
        desired = math.atan2(dx, dy)
        delta = _towards(self.heading, desired, self.turn_rate)

        # Vertical profile: hold cruise altitude, but run a real landing
        # approach (descend toward the runway) once we are closing on a
        # low-altitude destination such as an airport.
        target_z = self.cruise_altitude
        if self.waypoint is None and self.destination[2] < self.cruise_altitude - 200.0:
            if physics.h_distance(self.position, self.destination) < self.approach_radius:
                target_z = self.destination[2] + self.approach_altitude_offset
        target_z = physics.clamp_altitude(target_z, self.min_altitude, self.max_altitude)
        vz = physics.clamp_altitude(target_z - self.position[2], -self.climb_rate, self.climb_rate)
        return physics.to_velocity(self.heading + delta, self.speed, vz)

    # ----- trajectory management -----
    def commit(self, plan: Plan | None, comment: str = "") -> None:
        if plan is not None:
            plan.version = self.trajectory_version + 1
            plan.comment = comment
            self.trajectory_version = plan.version
            self.plan = plan
            self.pending_plan = None
            self.proposal_pending_to = None
            self.last_commit_at = 0.0

    def propose(self, proposal: Plan, to: str) -> None:
        self.pending_plan = proposal
        self.proposal_pending_to = to
        self.proposed_version = self.trajectory_version + 1

    def accept_pending(self) -> None:
        if self.pending_plan is not None:
            self.pending_plan.version = self.trajectory_version + 1
            self.trajectory_version = self.pending_plan.version
            self.plan = self.pending_plan
            self.pending_plan = None
            self.proposal_pending_to = None

    def reject_pending(self) -> None:
        self.pending_plan = None
        self.proposal_pending_to = None

    def in_cooldown(self, now: float) -> bool:
        return now < self.cooldown_until

    def start_cooldown(self, now: float) -> None:
        self.cooldown_until = now + self.cooldown_duration

    def set_emergency(self, value: bool) -> None:
        self.emergency = value
        if value:
            self.priority = PRIORITY_EMERGENCY

    def reached_destination(self, threshold: float = 80.0) -> bool:
        return physics.h_distance(self.position, self.destination) < threshold

    def is_landing(self) -> bool:
        if self.plan is not None or self.waypoint is not None:
            return False
        return (
            self.destination[2] < self.cruise_altitude - 200.0
            and physics.h_distance(self.position, self.destination) < self.approach_radius
        )

    def waypoint_reached(self, threshold: float = 250.0) -> bool:
        return self.waypoint is None or physics.h_distance(self.position, self.waypoint) < threshold

    def maneuver_plan(self, heading_offset: float, vertical_rate: float = 0.0) -> Plan:
        vel = physics.to_velocity(
            self.heading + heading_offset, self.speed, vertical_rate
        )
        return Plan(velocity=vel, duration=self.maneuver_duration)

    def snapshot(self) -> dict[str, Any]:
        velocity = self.current_velocity()
        if self.held:
            state = "held"
        elif self.is_landing():
            state = "landing"
        else:
            state = "cruise"
        return {
            "id": self.id,
            "position": list(self.position),
            "velocity": list(velocity),
            "heading": self.heading,
            "speed": math.hypot(velocity[0], velocity[1]),
            "vertical_rate": velocity[2],
            "destination": list(self.destination),
            "waypoint": list(self.waypoint) if self.waypoint is not None else None,
            "priority": self.priority,
            "emergency": self.emergency,
            "active": self.active,
            "origin_aid": self.origin_aid,
            "dest_aid": self.dest_aid,
            "state": state,
            "progress": min(1.0, self.leg_travelled / max(1.0, self.leg_distance)),
            "leg_distance": round(self.leg_distance, 1),
            "trajectory_version": self.trajectory_version,
            "plan": (
                [list(self.plan.velocity), self.plan.duration, self.plan.version]
                if self.plan is not None
                else None
            ),
            "maneuvering": self.plan is not None and self.plan.duration > 0,
            "landing": self.is_landing(),
            "distance": self.distance_travelled,
            "fuel": self.fuel_used,
        }


def _towards(current: float, target: float, max_delta: float) -> float:
    diff = (target - current + math.pi) % (2 * math.pi) - math.pi
    if abs(diff) <= max_delta:
        return diff
    return math.copysign(max_delta, diff)
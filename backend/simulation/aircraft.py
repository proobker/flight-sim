"""Aircraft node — local state, planner state, movement, flight phases.

Each aircraft has a performance type (fleet profile) and flies a phase
machine: taxi-out → line-up → takeoff → climbout → climb → cruise → descent
→ downwind → base → final → flare → rollout → taxi-in → parked, with an
optional go-around loop. When no runway is assigned (unit tests, legacy
paths), it free-flies straight to its destination as before.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from . import physics
from .fleet import TAXI_SPEED, AircraftType
from .terrain import TERRAIN_LOOKAHEAD_S, TERRAIN_MIN_CLEARANCE

PRIORITY_EMERGENCY = 4
PRIORITY_MEDICAL = 3
PRIORITY_PASSENGER = 2
PRIORITY_CARGO = 1
PRIORITY_NORMAL = 0

# Flight phases
PARKED = "parked"
TAXI_OUT = "taxi_out"
LINE_UP = "line_up"
TAKEOFF = "takeoff"
CLIMBOUT = "climbout"
CLIMB = "climb"
CRUISE = "cruise"
DESCENT = "descent"
DOWNWIND = "downwind"
BASE = "base"
FINAL = "final"
FLARE = "flare"
ROLLOUT = "rollout"
TAXI_IN = "taxi_in"
GO_AROUND = "go_around"

GROUND_PHASES = {PARKED, TAXI_OUT, LINE_UP, TAKEOFF, ROLLOUT, TAXI_IN}
ARRIVAL_PHASES = {DESCENT, DOWNWIND, BASE, FINAL, FLARE, GO_AROUND}
DEPARTURE_PHASES = {TAXI_OUT, LINE_UP, TAKEOFF, CLIMBOUT, CLIMB}

GS_TANGENT = math.tan(math.radians(3.0))


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
        fleet: AircraftType | None = None,
        terrain=None,
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

        self.type_: AircraftType = fleet or _default_fleet()
        self.wake = self.type_.wake
        self.terrain = terrain  # TerrainGrid | None

        # Terrain awareness state (updated by update_terrain_state each tick).
        self.terrain_wp: tuple[float, float, float] | None = None
        self.terrain_climb_target: float | None = None
        self.terrain_detour = False
        self.terrain_warning = False
        self.terrain_ahead = 0.0
        self.agl = 0.0

        self.heading = heading
        self.active = True
        self.emergency = False
        self.held = False
        self.origin_aid: str | None = None
        self.dest_aid: str | None = None
        self.leg_distance = 1.0
        self.leg_travelled = 0.0

        # Flight-phase extras
        self.phase = CRUISE
        self.runway: Any = None  # assigned Runway for this leg
        self.dep_runway: Any = None  # runway we depart from this turn
        self.dest_airport: Any = None
        self.line_up_cleared = False
        self.join_final = False
        self.go_around = False
        self.downwind_extension: float = 0.0
        self.rotated = False
        self.takeoff_origin: tuple[float, float, float] = (0.0, 0.0, 0.0)

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
        if self.plan is None:
            self.heading = math.atan2(velocity[0], velocity[1])
            self._step_speed(dt)
        if self.plan is not None:
            self.plan.duration = max(0.0, self.plan.duration - dt)
            if self.plan.duration <= 0.0:
                self.plan = None
        self._autopilot(dt)

    def current_velocity(self) -> tuple[float, float, float]:
        if self.plan is not None and self.plan.duration > 0:
            return self.plan.velocity
        if self.phase == PARKED or self.phase == LINE_UP:
            return (0.0, 0.0, 0.0)
        return self.steer_velocity()

    def _step_speed(self, dt: float) -> None:
        """Accelerate/decelerate `speed` toward the phase envelope target."""
        target = self._phase_speed()
        if self.speed < target:
            self.speed = min(target, self.speed + self.type_.acceleration * dt)
        elif self.speed > target:
            braking = self.type_.braking if self.phase in (FLARE, ROLLOUT, TAXI_IN, TAXI_OUT) else self.type_.acceleration
            self.speed = max(target, self.speed - braking * dt)

    def steer_velocity(self) -> tuple[float, float, float]:
        target, tz, speed = self._navigation_target()
        dx = target[0] - self.position[0]
        dy = target[1] - self.position[1]
        desired = math.atan2(dx, dy)
        delta = _towards(self.heading, desired, self.turn_rate)

        if self.phase in (FINAL, FLARE):
            vz = physics.clamp_altitude(tz - self.position[2], -self.type_.descend_rate, self.type_.climb_rate)
        else:
            vz = physics.clamp_altitude(tz - self.position[2], -self.type_.descend_rate, self.type_.climb_rate)
        if self.phase == TAKEOFF and not self.rotated:
            vz = 0.0  # rolling on the runway until rotation
        return physics.to_velocity(self.heading + delta, self.speed, vz)

    def _phase_speed(self) -> float:
        if self.phase in (LINE_UP, PARKED):
            return 0.0
        if self.phase == TAXI_OUT or self.phase == TAXI_IN:
            return TAXI_SPEED
        if self.phase == ROLLOUT:
            return 0.0
        return self.type_.fly_speed(self.phase)

    def _navigation_target(self) -> tuple[tuple[float, float, float], float, float]:
        """Returns (target_xy, target_alt, phase_speed) for the autopilot."""
        if self.runway is None:
            return self._legacy_target()

        dep = self.dep_runway or self.runway
        phase = self.phase

        # ---- departure / ground phases use the departure runway ----
        if phase == TAXI_OUT:
            pt = dep.departure_point()
            return self._nav(pt, dep.elevation, TAXI_SPEED)
        if phase == LINE_UP:
            pt = dep.departure_point()
            return self._nav(pt, dep.elevation, 0.0)
        if phase == TAKEOFF:
            ux, uy = dep.u
            far = (dep.threshold[0] + ux * 12000.0, dep.threshold[1] + uy * 12000.0, dep.elevation)
            if not self.rotated:
                return self._nav(far, dep.elevation, 0.0)
            return self._nav(far, self._takeoff_alt(dep.elevation), 0.0)
        if phase == CLIMBOUT:
            ux, uy = dep.u
            far = (dep.threshold[0] + ux * 24000.0, dep.threshold[1] + uy * 24000.0, dep.elevation)
            return self._nav(far, min(self.cruise_altitude, dep.elevation + 520.0), 0.0)

        # ---- arrival / pattern phases use the arrival runway ----
        rw = self.runway
        elev = rw.elevation
        if phase in (CLIMB, CRUISE):
            tgt = self.terrain_wp or self.waypoint or self.destination
            tz = max(self.cruise_altitude, self.terrain_climb_target or 0.0)
            return self._nav(tgt, tz, 0.0)
        if phase == GO_AROUND:
            entry = rw.downwind_entry(self.type_)
            return self._nav(entry, rw.pattern_alt(self.type_), 0.0)
        if phase == DESCENT:
            entry = rw.downwind_entry(self.type_)
            return self._nav(self.waypoint or entry, rw.pattern_alt(self.type_), 0.0)
        if phase == DOWNWIND:
            abeam = rw.downwind_abeam(self.type_)
            if self.downwind_extension > 0.0:
                ux, uy = rw.u
                abeam = (abeam[0] - ux * self.downwind_extension, abeam[1] - uy * self.downwind_extension, abeam[2])
            return self._nav(abeam, rw.pattern_alt(self.type_), 0.0)
        if phase == BASE:
            fix = rw.approach_fix(self.type_.final_len)
            return self._nav(fix, rw.pattern_alt(self.type_), 0.0)
        if phase in (FINAL, FLARE):
            thr = (rw.threshold[0], rw.threshold[1], elev)
            return self._nav(thr, self._final_alt(), 0.0)
        if phase == ROLLOUT:
            ux, uy = rw.u
            end = (rw.threshold[0] + ux * (rw.length * 0.55), rw.threshold[1] + uy * (rw.length * 0.55), elev)
            return self._nav(end, elev, 0.0)
        if phase == TAXI_IN:
            return self._nav(self.destination, elev, TAXI_SPEED)
        return self._nav(self.destination, elev, TAXI_SPEED)

    def _nav(self, target: tuple[float, float, float], tz: float, phase_speed: float) -> tuple[tuple[float, float, float], float, float]:
        """Wrap a navigation target with the terrain-clearance safety floor."""
        if self.terrain is not None and not self.is_grounded():
            tz = max(tz, self.terrain_height_at(target[0], target[1]), self.terrain_height_at(self.position[0], self.position[1])) + TERRAIN_MIN_CLEARANCE
        return target, tz, phase_speed

    def terrain_height_at(self, x: float, y: float) -> float:
        return self.terrain.height_at(x, y) if self.terrain is not None else 0.0

    def update_terrain_state(self) -> None:
        """TAWS-style look-ahead: raise the floor, warn, climb or route around.

        Drives ``terrain_climb_target`` (overfly when reachable) and
        ``terrain_detour``/``terrain_wp`` (re-route when a crest is too tall).
        """
        self.terrain_ahead = 0.0
        self.terrain_warning = False
        if self.terrain is None:
            self.terrain_wp = None
            self.terrain_climb_target = None
            self.terrain_detour = False
            self.agl = 0.0
            return

        px, py, pz = self.position
        self.agl = max(0.0, pz - self.terrain_height_at(px, py))

        if self.phase not in (CLIMB, CRUISE):
            self._clear_terrain_escape()
            return

        v = self.current_velocity()
        speed = math.hypot(v[0], v[1])
        look = max(2500.0, speed * TERRAIN_LOOKAHEAD_S)
        if speed > 1.0:
            hx, hy = v[0] / speed, v[1] / speed
        else:
            hx, hy = math.sin(self.heading), math.cos(self.heading)
        qx, qy = px + hx * look, py + hy * look
        max_e, frac = self.terrain.max_along((px, py, pz), (qx, qy, pz), step=max(200.0, look / 24.0))
        self.terrain_ahead = max_e

        required = max_e + TERRAIN_MIN_CLEARANCE
        if required <= pz - 5.0:
            # The way ahead is clear at our altitude — drop any terrain escape.
            self._clear_terrain_escape()
            return

        self.terrain_warning = True
        overflyable = required <= self.max_altitude
        speed_ok = speed > 1e-9
        t_peak = (frac * look) / speed if speed_ok else float("inf")
        t_climb = (required - pz) / max(self.type_.climb_rate, 0.5)
        if overflyable and t_climb <= t_peak + 2.0:
            # We can out-climb the rising ground before it reaches us.
            self.terrain_climb_target = max(self.terrain_climb_target or 0.0, required)
            self.terrain_detour = False
        else:
            # Too tall or too close — keep climbing as best effort and route around.
            self.terrain_climb_target = max(self.terrain_climb_target or 0.0, min(required, self.max_altitude))
            self.terrain_detour = True

    def _clear_terrain_escape(self) -> None:
        self.terrain_wp = None
        self.terrain_climb_target = None
        self.terrain_detour = False

    def _legacy_target(self) -> tuple[tuple[float, float, float], float, float]:
        """Original free-flight autopilot: straight to the destination."""
        target_z = self.cruise_altitude
        if self.waypoint is None and self.destination[2] < self.cruise_altitude - 200.0:
            if physics.h_distance(self.position, self.destination) < self.approach_radius:
                target_z = self.destination[2] + self.approach_altitude_offset
        target_z = physics.clamp_altitude(target_z, self.min_altitude, self.max_altitude)
        return (self.waypoint or self.destination, target_z, 0.0)

    def _takeoff_alt(self, elev: float) -> float:
        return elev + 40.0

    def _final_alt(self) -> float:
        if self.runway is None:
            return self.min_altitude
        h = physics.h_distance(self.position, self.runway.threshold)
        return self.runway.elevation + max(0.0, h * GS_TANGENT)

    # ----- phase transitions (pure geometry; agent grants external gates) -----
    def _autopilot(self, dt: float) -> None:
        if self.runway is None or self.phase in (PARKED, ROLLOUT):
            # PARKED / ROLLOUT are terminal phases: no transitional logic.
            return

        dep = self.dep_runway or self.runway
        pos = self.position

        if self.phase == TAXI_OUT:
            if physics.h_distance(pos, dep.departure_point()) < 90.0:
                self.phase = LINE_UP
                self.line_up_cleared = False
                dp = dep.departure_point()
                self.position = (dp[0], dp[1], dep.elevation)
                self.heading = dep.heading
                self.speed = 0.0
            return

        if self.phase == LINE_UP:
            if self.line_up_cleared:
                self.phase = TAKEOFF
                self.rotated = False
                self.takeoff_origin = tuple(pos)
            return

        if self.phase == TAKEOFF:
            if not self.rotated and self.speed >= self.type_.rotate_speed:
                self.rotated = True
            elif self.rotated and pos[2] >= dep.elevation + 25.0:
                self.phase = CLIMBOUT
                self.heading = dep.heading
            return

        if self.phase == CLIMBOUT:
            if pos[2] >= dep.elevation + 520.0:
                self.phase = CLIMB
            elif physics.h_distance(pos, self.takeoff_origin) > 26000.0:
                self.phase = CLIMB
            return

        if self.phase == CLIMB:
            if pos[2] >= self.cruise_altitude - 20.0:
                self.phase = CRUISE
                self.speed = max(self.type_.cruise_speed, self.speed)
            return

        if self.phase == CRUISE:
            if self._within_descent():
                self.phase = DESCENT
                self.downwind_extension = 0.0
            return

        rw = self.runway

        if self.phase in (BASE, FINAL, FLARE) and self.go_around:
            self.phase = GO_AROUND
            self.downwind_extension = 0.0
            self.join_final = False
            return

        if self.phase == DESCENT:
            entry = rw.downwind_entry(self.type_)
            if physics.h_distance(pos, entry) < 1200.0:
                self.phase = DOWNWIND
                self.join_final = False
                self.downwind_extension = 0.0
            return

        if self.phase == DOWNWIND:
            abeam = rw.downwind_abeam(self.type_)
            if self.downwind_extension > 0.0:
                ux, uy = rw.u
                abeam = (abeam[0] - ux * self.downwind_extension, abeam[1] - uy * self.downwind_extension, abeam[2])
            if physics.h_distance(pos, abeam) < 500.0 and self.join_final:
                self.phase = BASE
            return

        if self.phase == BASE:
            if abs(_angdiff(self.heading, rw.heading)) < math.radians(7.0):
                self.phase = FINAL
            return

        if self.phase == FINAL:
            thr = (rw.threshold[0], rw.threshold[1], rw.elevation)
            if physics.h_distance(pos, thr) < 550.0 and pos[2] - rw.elevation < 25.0:
                self.phase = FLARE
            return

        if self.phase == FLARE:
            thr = (rw.threshold[0], rw.threshold[1], rw.elevation)
            if physics.h_distance(pos, thr) < 60.0 or pos[2] <= rw.elevation + 1.0:
                self.position = thr
                self.phase = ROLLOUT
                self.heading = rw.heading
                self.speed = max(self.speed, TAXI_SPEED * 2.0)
            return

        if self.phase == TAXI_IN:
            if physics.h_distance(pos, self.destination) < 90.0:
                self.position = (self.destination[0], self.destination[1], self.destination[2])
                self.phase = PARKED
                self.speed = 0.0
                self.held = True
            return

        if self.phase == GO_AROUND:
            entry = rw.downwind_entry(self.type_)
            if physics.h_distance(pos, entry) < 1200.0:
                self.phase = DOWNWIND
                self.join_final = False
                self.downwind_extension = 0.0
                self.go_around = False
            return

    def _within_descent(self) -> bool:
        if self.runway is None or self.dest_airport is None:
            return False
        thr = self.runway.threshold
        h = physics.h_distance(self.position, thr)
        return h < self._descent_start()

    def _descent_start(self) -> float:
        if self.runway is None or self.type_ is None:
            return 30000.0
        pattern_alt = self.runway.elevation + self.type_.pattern_alt_agl
        return min(90000.0, max(24000.0, (self.cruise_altitude - pattern_alt) / GS_TANGENT))

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
        if self.runway is not None:
            return self.phase in ARRIVAL_PHASES
        return self.phase in ARRIVAL_PHASES or (
            self.plan is None
            and self.waypoint is None
            and self.destination[2] < self.cruise_altitude - 200.0
            and physics.h_distance(self.position, self.destination) < self.approach_radius
        )

    def is_grounded(self) -> bool:
        return self.phase in GROUND_PHASES

    def waypoint_reached(self, threshold: float = 250.0) -> bool:
        return self.waypoint is None or physics.h_distance(self.position, self.waypoint) < threshold

    def maneuver_plan(self, heading_offset: float, vertical_rate: float = 0.0) -> Plan:
        vel = physics.to_velocity(
            self.heading + heading_offset, self.speed, vertical_rate
        )
        return Plan(velocity=vel, duration=self.maneuver_duration)

    # ----- snapshot -----
    def _state_str(self) -> str:
        if self.held or self.phase in (PARKED, TAXI_OUT, LINE_UP, TAKEOFF, ROLLOUT, TAXI_IN):
            return "held"
        if self.phase in ARRIVAL_PHASES:
            return "landing"
        return "cruise"

    def snapshot(self) -> dict[str, Any]:
        velocity = self.current_velocity()
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
            "state": self._state_str(),
            "phase": self.phase,
            "type": self.type_.name,
            "wake": self.type_.wake,
            "runway": self.runway.rid if self.runway is not None else None,
            "dep_runway": self.dep_runway.rid if self.dep_runway is not None else None,
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
            "agl": round(self.agl, 1),
            "terrain_warning": self.terrain_warning,
            "terrain_ahead": round(self.terrain_ahead, 1),
            "distance": self.distance_travelled,
            "fuel": self.fuel_used,
        }


def _default_fleet():
    from .fleet import TYPES, REGIONAL

    return TYPES[REGIONAL]


def _angdiff(a: float, b: float) -> float:
    return (a - b + math.pi) % (2 * math.pi) - math.pi


def _towards(current: float, target: float, max_delta: float) -> float:
    diff = (target - current + math.pi) % (2 * math.pi) - math.pi
    if abs(diff) <= max_delta:
        return diff
    return math.copysign(max_delta, diff)
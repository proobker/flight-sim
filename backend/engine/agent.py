"""AircraftAgent — the distributed brain running inside every aircraft.

Each agent is an independent peer: it drains its UDP inbox, updates a local
world model, predicts conflicts, negotiates, moves, and broadcasts its state.
No agent sees the global state.

Terminal-area sequencing is handled by a shared tower (TerminalController):
agents request landing slots and departure clearance from it just like real
crews talk to a tower.
"""

from __future__ import annotations

import math
import random
from typing import Any

from ..network import protocol
from ..network.neighbor import NeighborTable
from ..network.udp_node import UdpNode
from ..simulation import physics
from ..simulation.aircraft import Aircraft, ARRIVAL_PHASES, GROUND_PHASES
from ..simulation.airspace import random_cruise_altitude
from ..simulation.conflict import Conflict, ConflictDetector
from ..simulation.maneuver import generate_candidates, filter_candidates
from ..simulation.cost import plan_cost
from ..simulation.negotiation import proposal_consensus_response
from ..simulation.uncertainty import SilentRegion
from ..simulation.terrain import TERRAIN_MIN_CLEARANCE


class AircraftAgent:
    def __init__(
        self,
        aircraft: Aircraft,
        node: UdpNode,
        detector: ConflictDetector,
        airspace,
        sim_time: float = 0.0,
        broadcast_every: int = 6,
        detect_every: int = 3,
        max_proposal_rounds: int = 2,
        comm_range: float = 6000.0,
        metrics=None,
        terminal=None,
    ) -> None:
        self.aircraft = aircraft
        self.node = node
        self.detector = detector
        self.airspace = airspace
        self.comm_range = comm_range
        self.metrics = metrics
        self.terminal = terminal
        self.neighbors = NeighborTable(node_id=aircraft.id)
        self.broadcast_every = broadcast_every
        self.detect_every = detect_every
        self.max_proposal_rounds = max_proposal_rounds
        self.tick = 0
        self.sim_time = sim_time
        self.negotiation_rounds: dict[str, int] = {}
        self.active_conflict_key: str | None = None
        self._active_record = None
        self.active_conflicts: dict[str, float] = {}
        self.hold_timer = 0.0
        self._final_registered = False
        self._slot_open: float | None = None
        self._dep_noted = False
        self._terrain_wp_at = 0.0

    @property
    def id(self) -> str:
        return self.aircraft.id

    # ----- message handling -----
    def drain_inbox(self) -> list[dict[str, Any]]:
        msgs: list[dict[str, Any]] = []
        while self.node.inbox:
            try:
                msgs.append(self.node.inbox.popleft())
            except IndexError:
                break
        return msgs

    def apply_messages(self, msgs: list[dict[str, Any]], now: float) -> None:
        for msg in msgs:
            mtype = msg.get("type")
            sender = msg.get("sender", "")
            if sender == self.id:
                continue
            if mtype in (protocol.HELLO, protocol.STATE_UPDATE, protocol.HEARTBEAT):
                self._ingest_neighbor(msg, now)
            elif mtype == protocol.TRAJECTORY_PROPOSAL:
                self._on_proposal(msg, now)
            elif mtype == protocol.TRAJECTORY_ACCEPT:
                if msg.get("target") == self.id:
                    self._commit_pending(now)
            elif mtype == protocol.TRAJECTORY_REJECT:
                if msg.get("target") == self.id:
                    winner = msg.get("winner") or msg.get("sender")
                    if winner != self.id:
                        self.aircraft.reject_pending()
                    else:
                        self._commit_pending(now)
            elif mtype == protocol.TRAJECTORY_COMMIT:
                self.neighbors.upsert(msg, now)

    def _ingest_neighbor(self, msg: dict[str, Any], now: float) -> None:
        sender = msg.get("sender", "")
        if sender == self.id:
            return
        pos = msg.get("position")
        if isinstance(pos, (list, tuple)) and msg.get("velocity"):
            if math.dist(self.aircraft.position, tuple(pos)) > self.comm_range:
                return
        self.neighbors.upsert(msg, now)

    def _on_proposal(self, msg: dict[str, Any], now: float) -> None:
        if msg.get("target") != self.id:
            return
        sender = msg.get("sender", "")
        version = int(msg.get("proposal_version", 0))
        if version and version <= self.aircraft.trajectory_version:
            return
        maneuver = msg.get("maneuver") or {}
        vel = tuple(maneuver.get("velocity", [0.0, 0.0, 0.0]))
        cost = float(msg.get("cost", 1e9))
        priority = int(msg.get("priority", 0))

        if not self._is_maneuver_safe(self.aircraft.position, vel):
            self.node.send(
                protocol.message(
                    protocol.TRAJECTORY_REJECT, self.id,
                    target=sender, proposal_id=msg.get("proposal_id"),
                    winner=sender, reason="unsafe",
                )
            )
            self._maybe_resolve_conflicts(now)
            return

        if self.aircraft.pending_plan is not None:
            my_pending = {
                "cost": plan_cost(self.aircraft.pending_plan, self.aircraft),
                "priority": self.aircraft.priority,
                "proposal_version": self.aircraft.proposed_version,
                "sender": self.id,
            }
            consensus = proposal_consensus_response(self.id, my_pending, msg)
        else:
            consensus = {
                "type": protocol.TRAJECTORY_ACCEPT,
                "target": sender,
                "proposal_id": msg.get("proposal_id"),
                "winner": sender,
                "cost": cost,
                "priority": priority,
            }

        self.node.send(protocol.message(consensus["type"], self.id, **consensus))
        if consensus["type"] == protocol.TRAJECTORY_REJECT and consensus.get("winner") == self.id:
            self._commit_pending(now)

    def _commit_pending(self, now: float) -> None:
        if self.aircraft.pending_plan is None:
            return
        self.aircraft.accept_pending()
        self.aircraft.start_cooldown(now)
        plan = self.aircraft.plan
        self.node.send(
            protocol.message(
                protocol.TRAJECTORY_COMMIT, self.id,
                sim_time=now,
                position=list(self.aircraft.position),
                velocity=list(plan.velocity if plan else self.aircraft.current_velocity()),
                heading=self.aircraft.heading,
                speed=self.aircraft.speed,
                vertical_rate=self.aircraft.current_velocity()[2],
                destination=list(self.aircraft.destination),
                priority=self.aircraft.priority,
                emergency=self.aircraft.emergency,
                trajectory_version=self.aircraft.trajectory_version,
                plan=[list(plan.velocity), plan.duration] if plan else [],
            )
        )

    def _is_maneuver_safe(self, start, velocity) -> bool:
        end = physics.advance(start, velocity, self.aircraft.maneuver_duration)
        if not self.airspace.in_bounds(end):
            return False
        if self.airspace.terrain is not None:
            if not self.airspace.terrain_motion_clear(start, velocity, self.aircraft.maneuver_duration, TERRAIN_MIN_CLEARANCE):
                return False
        for entry in self.neighbors.live_neighbors(self.sim_time):
            if self._skip_pair(entry):
                continue
            c = self.detector.detect_pair(start, velocity, entry.position, entry.velocity)
            if c is not None:
                return False
        return True

    # ----- tower / pattern cooperation -----
    def _skip_pair(self, entry) -> bool:
        """Tower-spaced or ground traffic does not negotiate pairwise."""
        me = self.aircraft
        if me.phase in GROUND_PHASES:
            return True
        if entry.phase in GROUND_PHASES:
            return True
        if (
            me.runway is not None
            and entry.dest_aid
            and me.dest_aid == entry.dest_aid
            and me.phase in ARRIVAL_PHASES
            and entry.phase in ARRIVAL_PHASES
        ):
            return True
        return False

    # ----- conflict detection & resolution -----
    def _first_conflict(self, now: float) -> Conflict | None:
        me = self.aircraft
        my_vel = me.current_velocity()
        candidates: list[Conflict] = []
        for entry in self.neighbors.live_neighbors(now):
            if self._skip_pair(entry):
                continue
            c = self.detector.detect_pair(me.position, my_vel, entry.position, entry.velocity)
            if c is not None:
                c.other_id = entry.aircraft_id
                candidates.append(c)
        for region in self._uncertain_neighbors(now):
            c = self.detector.detect_against_uncertainty(
                me.position, my_vel, region.other_id, region.position,
                region.uncertain_radius, region.altitude_envelope,
            )
            if c is not None:
                candidates.append(c)
        if not candidates:
            return None
        candidates.sort(key=lambda c: (c.against_uncertain, c.t))
        return candidates[0]

    def _uncertain_neighbors(self, now: float) -> list[SilentRegion]:
        regions: list[SilentRegion] = []
        for nid, entry in self.neighbors.entries.items():
            age = entry.age(now)
            if age > self.neighbors.stale_timeout:
                regions.append(SilentRegion(nid, entry.position, age))
        return regions

    def _maybe_resolve_conflicts(self, now: float) -> None:
        me = self.aircraft
        if me.in_cooldown(now) or not me.active:
            return
        if me.phase in GROUND_PHASES:
            self._expire_conflicts(now)
            return
        conflict = self._first_conflict(now)
        if conflict is None:
            self._expire_conflicts(now)
            return
        self._record_conflict(conflict, now)
        if not self._am_responsible(conflict.other_id):
            return
        candidates = filter_candidates(
            generate_candidates(self.aircraft, self.airspace, self.detector),
            self.aircraft.position,
            self.neighbors.live_neighbors(now),
            self._uncertain_neighbors(now),
            self.airspace,
            self.detector,
        )
        if not candidates:
            return
        best = min(candidates, key=lambda c: plan_cost(c.plan, self.aircraft))
        best.plan.comment = best.name
        self.aircraft.propose(best.plan, conflict.other_id)
        self.aircraft.conflicts_generated += 1

        rounds = self.negotiation_rounds.get(conflict.other_id, 0)
        if rounds >= self.max_proposal_rounds:
            self._commit_pending(now)
            return
        self.negotiation_rounds[conflict.other_id] = rounds + 1
        self.node.send(
            protocol.message(
                protocol.TRAJECTORY_PROPOSAL, self.id,
                target=conflict.other_id,
                proposal_id=f"{self.id}-{self.aircraft.trajectory_version + 1}-{random.randint(0, 9999)}",
                proposal_version=self.aircraft.proposed_version,
                maneuver={"velocity": list(best.plan.velocity), "duration": best.plan.duration},
                cost=plan_cost(best.plan, self.aircraft),
                priority=self.aircraft.priority,
                time_to_conflict=round(conflict.t, 2),
            )
        )

    def _am_responsible(self, other_id: str) -> bool:
        me = self.aircraft
        other_entry = self.neighbors.entries.get(other_id)
        other_priority = other_entry.priority if other_entry else 0
        if me.priority != other_priority:
            return me.priority > other_priority
        return me.id < other_id

    # ----- conflict bookkeeping (per-node, feeds central metrics) -----
    def _conflict_key(self, other_id: str) -> str:
        a, b = sorted([self.id, other_id])
        return f"{a}|{b}"

    def _record_conflict(self, conflict: Conflict, now: float) -> None:
        key = self._conflict_key(conflict.other_id)
        if key in self.active_conflicts:
            self.active_conflicts[key] = now
            return
        self.active_conflicts[key] = now
        if self.metrics is not None:
            from .metrics import ConflictRecord

            record = ConflictRecord(a=self.id, b=conflict.other_id, detected_at=now,
                                    maneuver=conflict.other_id)
            self.metrics.record_conflict(record)
            self._open_records = getattr(self, "_open_records", {})
            self._open_records[key] = record

    def _expire_conflicts(self, now: float) -> None:
        stale = [k for k, last in self.active_conflicts.items() if now - last > 1.0]
        for key in stale:
            del self.active_conflicts[key]
            if self.metrics is not None:
                record = getattr(self, "_open_records", {}).pop(key, None)
                if record is not None:
                    self.metrics.record_resolution(record, now)

    def active_conflict_ids(self) -> list[str]:
        return [k.split("|")[1] if k.split("|")[0] == self.id else k.split("|")[0]
                for k in self.active_conflicts]

    # ----- main loop step -----
    def step(self, dt: float) -> None:
        self.tick += 1
        if not self.aircraft.active:
            return
        self.sim_time += dt
        now = self.sim_time

        msgs = self.drain_inbox()
        self.apply_messages(msgs, now)

        # Parked/holding ticks: sit quiet, keep broadcasting so neighbours
        # never treat us as a silent/uncertain node.
        if self.hold_timer > 0:
            self.hold_timer -= dt
            if self.hold_timer <= 0:
                self.aircraft.held = False
                self._begin_departure()
            if self.tick % self.broadcast_every == 0:
                self._broadcast_state(now)
            return

        self.aircraft.advance(dt)
        self._manage_terminal(now, dt)

        # Terrain awareness: raise the floor, and climb or route around
        # rising ground while en route.
        ac = self.aircraft
        ac.update_terrain_state()
        if ac.phase in ("climb", "cruise"):
            if ac.terrain_detour:
                if ac.terrain_wp is None or now - self._terrain_wp_at > 1.0:
                    ac.terrain_wp = self.airspace.terrain_detour_waypoint(
                        ac.position, ac.destination, ac.position[2], TERRAIN_MIN_CLEARANCE
                    )
                    self._terrain_wp_at = now
            elif ac.terrain_wp is not None:
                ac.terrain_wp = None

        # Waypoint obstacle routing only en route; the pattern owns itself.
        if self.aircraft.plan is None:
            if self.aircraft.phase in ("climb", "cruise"):
                self.aircraft.waypoint = self.airspace.waypoint_around(
                    self.aircraft.position, self.aircraft.destination, 300.0
                )
            else:
                self.aircraft.waypoint = None

        if (
            self.aircraft.reached_destination()
            and self.aircraft.plan is None
            and self.aircraft.runway is None
        ):
            self._begin_hold()
        elif self.aircraft.phase == "parked" and self.aircraft.held and self.hold_timer <= 0:
            self.hold_timer = random.uniform(2.0, 6.0)

        if self.tick % self.broadcast_every == 0:
            self._broadcast_state(now)

        if not self.aircraft.is_grounded() and self.tick % self.detect_every == 0:
            self._maybe_resolve_conflicts(now)

    # ----- tower interaction -----
    def _manage_terminal(self, now: float, dt: float) -> None:
        terminal = self.terminal
        if terminal is None:
            return
        ac = self.aircraft
        r = ac.runway
        dr = ac.dep_runway

        if ac.phase in ("taxi_out", "line_up") and dr is not None and not ac.line_up_cleared:
            # Cleared while waiting at the hold pad (or as a fallback while
            # lining up) so departures never queue on the runway.
            ac.line_up_cleared = terminal.clear_for_departure(self.id, dr.rid, ac.type_.wake, now)
        elif ac.phase == "takeoff" and dr is not None:
            if not self._dep_noted:
                terminal.note_departure(self.id, dr.rid, ac.type_.wake, now)
                self._dep_noted = True
        elif ac.phase == "climbout" and dr is not None:
            terminal.note_departure_airborne(dr.rid, now)
        elif ac.phase == "descent":
            if not self._final_registered:
                eta = now + self._eta_to_join(ac)
                self._slot_open = terminal.request_final(self.id, r.rid, ac.type_.wake, eta, now)
                self._final_registered = True
        elif ac.phase == "downwind":
            if self._slot_open is None or terminal.slot_open(self.id, r.rid, now):
                ac.join_final = True
            else:
                ac.downwind_extension += ac.type_.descend_speed * dt
        elif ac.phase == "base":
            if self._slot_open is None or terminal.slot_open(self.id, r.rid, now):
                ac.join_final = True
        elif ac.phase in ("final", "flare"):
            if terminal.landing_blocked(self.id, r.rid, now):
                ac.go_around = True
                self._final_registered = False
                self._slot_open = None
                self._dep_noted = False
        elif ac.phase == "go_around":
            ac.join_final = False
            if not self._final_registered:
                eta = now + self._eta_to_join(ac)
                self._slot_open = terminal.request_go_around(self.id, r.rid, ac.type_.wake, eta, now)
                self._final_registered = True
        elif ac.phase == "rollout":
            terminal.note_landed(self.id, r.rid, now)
        elif ac.phase in ("taxi_in", "parked"):
            self._final_registered = False
            self._slot_open = None
            self._dep_noted = False

    def _eta_to_join(self, ac: Aircraft) -> float:
        """Approx seconds until this aircraft reaches the final fix."""
        if ac.runway is None:
            return 300.0
        r = ac.runway
        t = ac.type_
        entry = r.downwind_entry(t)
        abeam = r.downwind_abeam(t)
        fix = r.approach_fix(t.final_len)
        metres = (
            physics.h_distance(ac.position, entry)
            + physics.h_distance(entry, abeam)
            + physics.h_distance(abeam, fix)
            + t.final_len
        )
        return metres / max(t.descend_speed, 1.0)

    # ----- landing / takeoff lifecycle -----
    def _begin_hold(self) -> None:
        ac = self.aircraft
        ac.held = True
        ac.speed = 0.0
        ac.plan = None
        dest = ac.destination
        ac.position = (
            dest[0],
            dest[1],
            self.airspace.ground_alt(dest[0], dest[1], dest[2]),
        )
        ac.heading = 0.0
        self.hold_timer = random.uniform(8.0, 14.0)

    def _begin_departure(self) -> None:
        ac = self.aircraft
        # Already configured for departure (fresh spawn) — just taxi.
        if ac.phase == "taxi_out" and ac.dep_runway is not None and ac.runway is not None:
            ac.held = False
            self._reset_leg_flags()
            return

        ac.held = False
        port = self.airspace.airport_by_id(ac.dest_aid) or self.airspace.random_airport()
        next_port = self.airspace.random_airport(exclude_id=port.aid)
        dep_rwy = port.active_runway(self.airspace.wind)
        dest_rwy = self.airspace.pick_runway(next_port)
        slot = int(ac.id[-1]) % 4
        hold = dep_rwy.departure_hold_point(slot)
        hold_z = self.airspace.ground_alt(hold[0], hold[1], dep_rwy.elevation)
        ac.hold_point = (hold[0], hold[1], hold_z)

        ac.phase = "taxi_out"
        ac.position = (hold[0], hold[1], hold_z)
        ac.dep_runway = dep_rwy
        ac.runway = dest_rwy
        ac.dest_airport = next_port
        ac.destination = next_port.position
        ac.origin_aid = port.aid
        ac.dest_aid = next_port.aid
        ac.cruise_altitude = random_cruise_altitude()
        ac.leg_distance = max(1.0, physics.h_distance(ac.hold_point, next_port.position))
        ac.leg_travelled = 0.0
        ac.plan = None
        ac.heading = dep_rwy.heading
        ac.speed = 0.0
        ac.line_up_cleared = False
        ac.join_final = False
        ac.go_around = False
        ac.downwind_extension = 0.0
        ac.rotated = False
        self._reset_leg_flags()

    def _reset_leg_flags(self) -> None:
        self._final_registered = False
        self._slot_open = None
        self._dep_noted = False

    def _broadcast_state(self, now: float) -> None:
        a = self.aircraft
        vel = a.current_velocity()
        self.node.send(
            protocol.state_update(
                a.id, now, a.position, vel, a.heading, a.speed, vel[2],
                a.destination, a.priority, a.emergency, a.trajectory_version,
                [list(a.plan.velocity)] if a.plan else [],
                phase=a.phase,
                wake=a.type_.wake,
                origin_aid=a.origin_aid,
                dest_aid=a.dest_aid,
            )
        )

    def snapshot(self, now: float) -> dict[str, Any]:
        return {
            **self.aircraft.snapshot(),
            "neighbors": self.neighbors.as_dict(now, self.aircraft.position),
        }
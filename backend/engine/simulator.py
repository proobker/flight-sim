"""Simulator — main async simulation engine.

Spawns one AircraftAgent + UdpNode per aircraft, runs the tick loop,
collects metrics, and streams snapshots for the WebSocket API.
"""

from __future__ import annotations

import asyncio
import itertools
import math
import random
from dataclasses import dataclass
from typing import Any

from ..network.udp_node import UdpNode
from ..simulation import physics
from ..simulation.aircraft import Aircraft, CRUISE
from ..simulation.airspace import Airspace, cruise_altitude_over_route, random_cruise_altitude
from ..simulation.conflict import ConflictDetector
from ..simulation.fleet import assign_type
from ..terminal import TerminalController
from .agent import AircraftAgent
from .metrics import Metrics

import logging

logger = logging.getLogger(__name__)

# Ambient wind vector (metres/sec): the air mass moves toward the
# west-southwest (i.e. the wind is coming FROM the east-northeast, ~063°).
WIND = (-7.0, -3.5, 0.0)


def _wind_direction(vector: tuple[float, float, float]) -> str:
    """Meteorological compass bearing (degrees, from-north clockwise) that the
    wind is blowing FROM, derived from the air-mass velocity vector."""
    vx, vy = float(vector[0]), float(vector[1])
    if math.hypot(vx, vy) < 1e-9:
        return "calm"
    toward = (90.0 - math.degrees(math.atan2(vy, vx))) % 360.0
    return f"{round((toward + 180.0) % 360.0):03d}°"


@dataclass
class SimConfig:
    num_aircraft: int = 120
    airborne_fraction: float = 0.65
    tick_rate: float = 12.0
    sim_speed: float = 1.0
    airspace_width: float = 160000.0
    airspace_depth: float = 160000.0
    airspace_floor: float = 100.0
    airspace_ceiling: float = 6000.0
    cruise_altitude: float = 2000.0
    speed_range: tuple[float, float] = (120.0, 220.0)
    comm_range: float = 24000.0
    packet_loss: float = 0.0
    latency_ms: float = 0.0
    multicast_group: str = "239.255.42.99"
    multicast_port: int = 42099
    terrain_seed: int | None = 1337


class Simulator:
    def __init__(self, config: SimConfig | None = None) -> None:
        self.config = config or SimConfig()
        self.airspace = Airspace(
            width=self.config.airspace_width,
            depth=self.config.airspace_depth,
            floor=self.config.airspace_floor,
            ceiling=self.config.airspace_ceiling,
            wind=WIND,
            terrain_seed=self.config.terrain_seed,
        )
        self.detector = ConflictDetector(airspace=self.airspace)
        self.terminal = TerminalController()
        self.agents: list[AircraftAgent] = []
        self.node_ids: dict[str, UdpNode] = {}
        self.metrics = Metrics()
        self.sim_time = 0.0
        self.running = False
        self._task: asyncio.Task | None = None
        self._broadcast_task: asyncio.Task | None = None
        self._snapshot_callbacks: list = []
        self._rng = random.Random(42)
        self._next_id = itertools.count(1, 1)
        self._spawned = 0

    async def start(self) -> None:
        await self._spawn_aircraft(self.config.num_aircraft)
        self.running = True
        self._task = asyncio.create_task(self._loop())
        self._broadcast_task = asyncio.create_task(self._broadcast_loop())

    async def stop(self) -> None:
        self.running = False
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        for agent in list(self.agents):
            agent.aircraft.active = False
            await agent.node.stop()

    def on_snapshot(self, callback) -> None:
        self._snapshot_callbacks.append(callback)

    # ----- spawn / kill -----
    async def _spawn_aircraft(self, count: int | None = None) -> None:
        """Fill the world: `airborne_fraction` of the fleet is already in the
        air (cruise/descent feeding the pattern flows) so traffic is dense
        from t=0; the rest queue on hold pads waiting for runway clearance.

        `count=None` spawns the configured fleet size; an explicit `count=0`
        spawns nothing.
        """
        if count is None:
            count = self.config.num_aircraft
        airborne = int(count * self.config.airborne_fraction)
        for _ in range(count):
            aid = f"A{next(self._next_id):03d}"
            if airborne > 0:
                airborne -= 1
                self._spawn_airborne(aid)
            else:
                self._spawn_ground(aid)

    def _spawn_ground(self, aid: str) -> None:
        """A departure waiting at the off-runway hold pad of its departure
        runway; the tower clears it into the runway when the arrival flow
        allows."""
        start = self.airspace.random_airport(self._rng)
        dest_airport = self.airspace.random_airport(self._rng, exclude_id=start.aid)
        dep_rwy = start.active_runway(self.airspace.wind)
        dest_rwy = self.airspace.pick_runway(dest_airport)
        fleet = assign_type(self._rng, hub=start.hub)
        slot = int(aid[-1]) % 4
        hold = dep_rwy.departure_hold_point(slot)
        hold = (hold[0], hold[1], self.airspace.ground_alt(hold[0], hold[1], dep_rwy.elevation))
        ac = Aircraft(
            aircraft_id=aid,
            position=hold,
            destination=dest_airport.position,
            speed=0.0,
            heading=dep_rwy.heading,
            cruise_altitude=cruise_altitude_over_route(
                random_cruise_altitude(self._rng),
                self.airspace.terrain,
                hold,
                dest_airport.position,
            ),
            priority=self._rng.choice([0, 0, 0, 0, 0, 1, 1, 2, 2, 4]),
            fleet=fleet,
        )
        ac.phase = "taxi_out"
        ac.hold_point = hold
        ac.dep_runway = dep_rwy
        ac.runway = dest_rwy
        ac.dest_airport = dest_airport
        ac.origin_aid = start.aid
        ac.dest_aid = dest_airport.aid
        ac.leg_distance = physics.h_distance(hold, dest_airport.position)
        self._wire_agent(ac, start)
        self._spawned += 1

    def _spawn_airborne(self, aid: str) -> None:
        """A flight already in the air, headed for the pattern of its runway."""
        start = self.airspace.random_airport(self._rng)
        dest_port = self.airspace.random_airport(self._rng, exclude_id=start.aid)
        dest_rwy = self.airspace.pick_runway(dest_port)
        fleet = assign_type(self._rng, hub=dest_port.hub)
        dest = dest_port.position
        ang = self._rng.uniform(0.0, 2.0 * math.pi)
        dist = self._rng.uniform(22000.0, 65000.0)
        px = dest[0] + math.cos(ang) * dist
        py = dest[1] + math.sin(ang) * dist
        px, py, _ = self.airspace.enforce_bounds((px, py, self.config.cruise_altitude))
        altitude = cruise_altitude_over_route(
            random_cruise_altitude(self._rng),
            self.airspace.terrain,
            (px, py, 0.0),
            dest,
        )
        heading = math.atan2(dest[0] - px, dest[1] - py)
        ac = Aircraft(
            aircraft_id=aid,
            position=(px, py, altitude),
            destination=dest,
            speed=fleet.cruise_speed,
            heading=heading,
            cruise_altitude=altitude,
            priority=self._rng.choice([0, 0, 0, 0, 0, 1, 1, 2, 2, 4]),
            fleet=fleet,
        )
        ac.phase = "descent" if physics.h_distance((px, py, altitude), dest) < 36000.0 else CRUISE
        ac.runway = dest_rwy
        ac.dest_airport = dest_port
        ac.origin_aid = start.aid
        ac.dest_aid = dest_port.aid
        ac.leg_distance = max(1.0, physics.h_distance((px, py, altitude), dest))
        ac.leg_travelled = self._rng.uniform(0.0, ac.leg_distance * 0.9)
        self._wire_agent(ac)
        self._spawned += 1

    def _wire_agent(self, ac: Aircraft, port=None) -> None:
        aid = ac.id
        node = UdpNode(
            aircraft_id=aid,
            multicast_group=self.config.multicast_group,
            multicast_port=self.config.multicast_port,
            loss=self.config.packet_loss,
            latency_ms=self.config.latency_ms,
            rng=self._rng,
        )
        agent = AircraftAgent(
            aircraft=ac,
            node=node,
            detector=self.detector,
            airspace=self.airspace,
            sim_time=self.sim_time,
            broadcast_every=6,
            detect_every=3,
            max_proposal_rounds=2,
            comm_range=self.config.comm_range,
            metrics=self.metrics,
            terminal=self.terminal,
            rng=self._rng,
        )
        if port is not None:
            agent.hold_timer = self._rng.uniform(0.0, 6.0)
        node.start()
        ac.terrain = self.airspace.terrain
        self.agents.append(agent)
        self.node_ids[aid] = node

    async def spawn_emergency(self) -> AircraftAgent:
        aid = f"E{next(self._next_id):03d}"
        pos = self.airspace.random_point(self._rng, self.config.cruise_altitude)
        dest_port = self.airspace.random_airport(self._rng)
        dest = dest_port.position
        ac = Aircraft(
            aircraft_id=aid,
            position=pos,
            destination=dest,
            speed=180.0,
            priority=4,
            cruise_altitude=cruise_altitude_over_route(
                random_cruise_altitude(self._rng),
                self.airspace.terrain,
                pos,
                dest,
            ),
        )
        ac.dest_aid = dest_port.aid
        ac.leg_distance = math.hypot(dest[0] - pos[0], dest[1] - pos[1])
        self._wire_agent(ac)
        self._spawned += 1
        return self.agents[-1]

    async def kill_aircraft(self, aircraft_id: str) -> bool:
        agent = self._find_agent(aircraft_id)
        if agent is None:
            return False
        if not agent.aircraft.active:
            return False
        agent.aircraft.active = False
        agent.aircraft.plan = None
        agent.aircraft.destination = agent.aircraft.position
        agent.aircraft.speed = 0
        self.metrics.network_nodes_failed += 1
        node = self.node_ids.pop(aircraft_id, None)
        if node:
            await node.stop()
        return True

    async def kill_random(self, count: int = 1) -> list[str]:
        ids = [a.id for a in self.agents if a.aircraft.active]
        targets = self._rng.sample(ids, min(count, len(ids)))
        for tid in targets:
            await self.kill_aircraft(tid)
        return targets

    # ----- partition / controls -----
    def partition_network(self, by: str = "midline") -> int:
        if not self.agents:
            return 0
        left, right = [], []
        for agent in self.agents:
            if not agent.aircraft.active:
                continue
            if agent.aircraft.position[0] < self.airspace.width / 2:
                left.append(agent)
            else:
                right.append(agent)
        for a in left:
            a.node.partition = "partition_a"
            a.node.blocked_partitions = {"partition_b"}
        for a in right:
            a.node.partition = "partition_b"
            a.node.blocked_partitions = {"partition_a"}
        self.metrics.partition_events += 1
        return 2

    def rejoin_network(self) -> None:
        for agent in self.agents:
            agent.node.partition = "main"
            agent.node.blocked_partitions.clear()

    def set_packet_loss(self, value: float) -> None:
        self.config.packet_loss = value
        for agent in self.agents:
            agent.node.set_loss(value)

    def set_latency(self, ms: float) -> None:
        self.config.latency_ms = ms
        for agent in self.agents:
            agent.node.set_latency(ms)

    def add_storm(self, center=None) -> None:
        if center is None:
            center = (
                self._rng.uniform(self.airspace.width * 0.3, self.airspace.width * 0.7),
                self._rng.uniform(self.airspace.depth * 0.3, self.airspace.depth * 0.7),
                self.config.cruise_altitude,
            )
        self.airspace.add_obstacle("STORM", center, 1500.0, 4000.0)

    def close_airport(self, aid: str | None = None):
        """Close an airport and divert every airborne flight bound for it.

        Grounded traffic (parked/taxiing) is left alone: those crews pick an
        open field for their next leg via ``random_airport`` already. Anything
        in the air — cruise, descent, even mid-pattern — is rerouted to a new
        open destination so the closed field never receives another landing.
        """
        target = self.airspace.close_airport(aid, rng=self._rng)
        if target is None:
            return None
        for agent in self.agents:
            ac = agent.aircraft
            if not ac.active:
                continue
            if ac.dest_aid != target.aid:
                continue
            if ac.is_grounded():
                continue
            self._divert(ac, agent)
        return target

    def _divert(self, ac: Aircraft, agent) -> None:
        """Re-target an airborne aircraft onto a fresh open airport."""
        dest_port = self.airspace.random_airport(exclude_id=ac.dest_aid)
        ac.dest_aid = dest_port.aid
        ac.dest_airport = dest_port
        ac.destination = dest_port.position
        ac.runway = self.airspace.pick_runway(dest_port)
        ac.leg_distance = max(1.0, physics.h_distance(ac.position, dest_port.position))
        ac.leg_travelled = 0.0
        ac.waypoint = None
        ac.terrain_wp = None
        ac.terrain_climb_target = None
        ac.terrain_detour = False
        ac.plan = None
        ac.pending_plan = None
        ac.proposal_pending_to = None
        ac.go_around = False
        ac.join_final = False
        ac.downwind_extension = 0.0
        ac.line_up_cleared = False
        ac.phase = CRUISE
        agent._reset_leg_flags()

    async def add_nofly(self, center=None) -> None:
        if center is None:
            center = (
                self._rng.uniform(self.airspace.width * 0.3, self.airspace.width * 0.7),
                self._rng.uniform(self.airspace.depth * 0.3, self.airspace.depth * 0.7),
                self.config.cruise_altitude,
            )
        self.airspace.add_obstacle("NO_FLY", center, 1800.0, 5000.0)

    # ----- simulation loop -----
    async def _loop(self) -> None:
        dt = 1.0 / self.config.tick_rate
        try:
            while self.running:
                await asyncio.sleep(dt / self.config.sim_speed)
                self.sim_time += dt
                for agent in list(self.agents):
                    try:
                        agent.step(dt)
                    except Exception:
                        logger.exception("agent %s step failed; continuing", agent.id)
                self._collect_metrics()
        except asyncio.CancelledError:
            return

    async def _broadcast_loop(self) -> None:
        try:
            while self.running:
                await asyncio.sleep(0.1)
                for cb in list(self._snapshot_callbacks):
                    try:
                        cb(self.snapshot())
                    except Exception:
                        pass
        except asyncio.CancelledError:
            return

    def _collect_metrics(self) -> None:
        self._check_collisions_and_separation()
        self._update_stale_metrics()

    def _check_collisions_and_separation(self) -> None:
        active = [a for a in self.agents
                  if a.aircraft.active and not a.aircraft.held and not a.aircraft.is_grounded()]
        min_sep = float("inf")
        for i in range(len(active)):
            for j in range(i + 1, len(active)):
                d = math.dist(
                    active[i].aircraft.position,
                    active[j].aircraft.position,
                )
                if d < min_sep:
                    min_sep = d
                if d < 20.0:
                    self.metrics.collisions += 1
                elif d < 500.0:
                    self.metrics.near_misses += 1
        if min_sep < float("inf"):
            self.metrics.observe_min_separation(min_sep)

    def _update_stale_metrics(self) -> None:
        for agent in self.agents:
            if not agent.aircraft.active:
                continue
            for entry in agent.neighbors.entries.values():
                if entry.age(self.sim_time) > agent.neighbors.hard_timeout:
                    pass  # recorded via network stats

    def _find_agent(self, aircraft_id: str) -> AircraftAgent | None:
        for a in self.agents:
            if a.id == aircraft_id:
                return a
        return None

    # ----- snapshots -----
    def snapshot(self) -> dict[str, Any]:
        active_agents = [a for a in self.agents if a.aircraft.active]
        active_count = len(active_agents)
        aircraft = []
        active_conflicts = 0
        for a in active_agents:
            snap = a.snapshot(self.sim_time)
            snap["conflict_with"] = a.active_conflict_ids()
            active_conflicts += len(snap["conflict_with"])
            aircraft.append(snap)
        total = len(self.agents)
        return {
            "time": round(self.sim_time, 2),
            "config": {
                "multicast_group": self.config.multicast_group,
                "multicast_port": self.config.multicast_port,
                "comm_range": self.config.comm_range,
            },
            "airspace": self.airspace.snapshot(),
            "wind": {"vector": list(WIND), "speed": round(math.hypot(WIND[0], WIND[1]), 1), "direction": _wind_direction(WIND)},
            "aircraft_count": active_count,
            "total_spawned": total,
            "active": active_count,
            "network_nodes_total": total,
            "active_conflicts": active_conflicts // 2,
            "collisions": self.metrics.collisions,
            "near_misses": self.metrics.near_misses,
            "min_separation": None if self.metrics.min_separation == float("inf") else round(self.metrics.min_separation, 1),
            "conflicts_detected": self.metrics.conflict_count,
            "conflicts_resolved": self.metrics.resolved_count,
            "avg_resolution_ms": self.metrics.avg_resolution_ms(),
            "nodes_failed": self.metrics.network_nodes_failed,
            "partition_events": self.metrics.partition_events,
            "aircraft": aircraft,
        }
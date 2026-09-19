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
from ..simulation.aircraft import Aircraft
from ..simulation.airspace import Airspace, random_cruise_altitude
from ..simulation.conflict import ConflictDetector
from ..simulation.fleet import assign_type
from ..terminal import TerminalController
from .agent import AircraftAgent
from .metrics import Metrics

# Ambient wind vector (metres/sec), roughly 8 m/s westerly.
WIND = (-7.0, -3.5, 0.0)


@dataclass
class SimConfig:
    num_aircraft: int = 40
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


class Simulator:
    def __init__(self, config: SimConfig | None = None) -> None:
        self.config = config or SimConfig()
        self.airspace = Airspace(
            width=self.config.airspace_width,
            depth=self.config.airspace_depth,
            floor=self.config.airspace_floor,
            ceiling=self.config.airspace_ceiling,
            wind=WIND,
        )
        self.detector = ConflictDetector(airspace=self.airspace)
        self.terminal = TerminalController()
        self.agents: list[AircraftAgent] = []
        self.node_ids: dict[str, UdpNode] = {}
        self.metrics = Metrics()
        self.sim_time = 0.0
        self.running = False
        self._task: asyncio.Task | None = None
        self._snapshot_callbacks: list = []
        self._rng = random.Random(42)
        self._next_id = itertools.count(1, 1)
        self._spawned = 0

    async def start(self) -> None:
        await self._spawn_aircraft(self.config.num_aircraft)
        self.running = True
        self._task = asyncio.create_task(self._loop())
        asyncio.create_task(self._broadcast_loop())

    async def stop(self) -> None:
        self.running = False
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
    async def _spawn_aircraft(self, count: int) -> None:
        for _ in range(count):
            aid = f"A{next(self._next_id):03d}"
            start = self.airspace.random_airport(self._rng)
            dest_airport = self.airspace.random_airport(self._rng, exclude_id=start.aid)
            dep_rwy = start.active_runway(self.airspace.wind)
            dest_rwy = self.airspace.pick_runway(dest_airport)
            fleet = assign_type(self._rng, hub=start.hub)
            pos, heading = self._departure_spot(dep_rwy)
            ac = Aircraft(
                aircraft_id=aid,
                position=pos,
                destination=dest_airport.position,
                speed=0.0,
                heading=heading,
                cruise_altitude=random_cruise_altitude(self._rng),
                priority=random.choice([0, 0, 0, 0, 0, 1, 1, 2, 2, 4]),
                fleet=fleet,
            )
            ac.phase = "taxi_out"
            ac.dep_runway = dep_rwy
            ac.runway = dest_rwy
            ac.dest_airport = dest_airport
            ac.origin_aid = start.aid
            ac.dest_aid = dest_airport.aid
            ac.leg_distance = physics.h_distance(pos, dest_airport.position)
            self._wire_agent(ac, start)
            self._spawned += 1

    def _departure_spot(self, runway) -> tuple[tuple[float, float, float], float]:
        """A taxi-out start just past the departure end, staggered a little."""
        ux, uy = runway.u
        back = self._rng.uniform(30.0, 260.0)
        px = runway.threshold[0] - ux * runway.length - ux * back
        py = runway.threshold[1] - uy * runway.length - uy * back
        return (px, py, runway.elevation), runway.heading

    def _wire_agent(self, ac: Aircraft, port=None) -> None:
        aid = ac.id
        node = UdpNode(
            aircraft_id=aid,
            multicast_group=self.config.multicast_group,
            multicast_port=self.config.multicast_port,
            loss=self.config.packet_loss,
            latency_ms=self.config.latency_ms,
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
        )
        if port is not None:
            agent.hold_timer = self._rng.uniform(0.0, 6.0)
        node.start()
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
            cruise_altitude=random_cruise_altitude(self._rng),
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
        targets = random.sample(ids, min(count, len(ids)))
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

    def close_airport(self) -> None:
        self.airspace.close_airport()

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
                    agent.step(dt)
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
            "wind": {"vector": list(WIND), "speed": round(math.hypot(WIND[0], WIND[1]), 1), "direction": "278°"},
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
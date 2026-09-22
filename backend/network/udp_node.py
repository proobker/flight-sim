"""SkyMesh UDP network layer.

Every aircraft is an independent UDP peer. All peers join a local multicast
group and broadcast JSON datagrams; each node drains its own socket and
filters inbound traffic by communication range and target field. This models
a single-host mesh network over real datagram sockets.

Per-node failure parameters injected at the network layer:
    packet_loss      probability [0,1] that an outbound datagram is dropped
    latency_ms       artificial one-way delay applied to outbound datagrams
    jitter_ms        random added delay
    blocked          set of partition IDs this node refuses to hear from
"""

from __future__ import annotations

import asyncio
import collections
import ipaddress
import random
import socket
from dataclasses import dataclass
from typing import Any

from . import protocol


@dataclass
class NodeStats:
    sent: int = 0
    received: int = 0
    dropped: int = 0
    delivered: int = 0
    queued_outgoing: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "sent": self.sent,
            "received": self.received,
            "dropped": self.dropped,
            "delivered": self.delivered,
            "queued_outgoing": self.queued_outgoing,
        }


class UdpNode:
    """One aircraft's UDP socket + send/receive loop."""

    def __init__(
        self,
        aircraft_id: str,
        multicast_group: str,
        multicast_port: int,
        loop: asyncio.AbstractEventLoop | None = None,
        loss: float = 0.0,
        latency_ms: float = 0.0,
        jitter_ms: float = 0.0,
        partition: str = "main",
        rng=None,
    ) -> None:
        self.id = aircraft_id
        self.group = multicast_group
        self.port = multicast_port
        self.loop = loop or asyncio.get_event_loop()
        self.address = (multicast_group, multicast_port)
        self._rng = rng if rng is not None else random

        self.partition = partition
        self.blocked_partitions: set[str] = set()

        self.loss = loss
        self.latency_ms = latency_ms
        self.jitter_ms = jitter_ms

        self.stats = NodeStats()
        self.inbox: collections.deque[dict[str, Any]] = collections.deque(maxlen=8192)
        self._socket: socket.socket | None = None
        self._reader_task: asyncio.Task | None = None

    def bind(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        sock.bind(("", self.port))
        if ipaddress.ip_address(self.group).is_multicast:
            # All peers live in this process, so pin multicast to the loopback
            # interface. Relying on the default interface fails in container /
            # cloud network namespaces that filter multicast traffic.
            loopback = socket.inet_aton("127.0.0.1")
            try:
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, loopback)
                mreq = socket.inet_aton(self.group) + loopback
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            except OSError:
                # Fall back to the default interface on platforms that cannot
                # multicast over loopback.
                default = socket.inet_aton("0.0.0.0")
                try:
                    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, default)
                except OSError:
                    pass
                mreq = socket.inet_aton(self.group) + default
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        sock.setblocking(False)
        self._socket = sock

    def start(self) -> None:
        if self._socket is None:
            self.bind()
        self._reader_task = self.loop.create_task(self._read_loop())

    async def stop(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._socket is not None:
            try:
                self._socket.close()
            except OSError:
                pass
            self._socket = None

    async def _read_loop(self) -> None:
        assert self._socket is not None
        while True:
            try:
                raw, _addr = await self.loop.sock_recvfrom(self._socket, 65535)
            except (OSError, asyncio.CancelledError):
                return
            self.stats.received += 1
            try:
                msg = protocol.decode(raw)
            except (ValueError, TypeError):
                self.stats.dropped += 1
                continue
            if self.blocked_partitions and msg.get("_partition", "") in self.blocked_partitions:
                self.stats.dropped += 1
                continue
            self.inbox.append(msg)
            self.stats.delivered += 1

    def send(self, msg: dict[str, Any]) -> None:
        """Serialize and fire a datagram into the multicast group."""
        if self._socket is None:
            return
        if msg.get("sender") != self.id:
            msg["sender"] = self.id
        msg["_partition"] = self.partition

        if self.loss > 0.0 and self._rng.random() < self.loss:
            self.stats.dropped += 1
            return

        delay_ms = self.latency_ms
        if self.jitter_ms > 0.0:
            delay_ms += self._rng.uniform(-self.jitter_ms, self.jitter_ms)
        delay = max(0.0, delay_ms) / 1000.0

        self.stats.sent += 1

        if delay <= 0.0:
            self._fire(msg)
        else:
            self.stats.queued_outgoing += 1
            self.loop.create_task(self._delayed_fire(delay, msg))

    def _fire(self, msg: dict[str, Any]) -> None:
        if self._socket is None:
            return
        try:
            self._socket.sendto(protocol.encode(msg), (self.group, self.port))
        except (OSError, TypeError):
            self.stats.dropped += 1

    async def _delayed_fire(self, delay: float, msg: dict[str, Any]) -> None:
        await asyncio.sleep(delay)
        self.stats.queued_outgoing = max(0, self.stats.queued_outgoing - 1)
        self._fire(msg)

    def set_loss(self, value: float) -> None:
        self.loss = max(0.0, min(1.0, value))

    def set_latency(self, value_ms: float) -> None:
        self.latency_ms = max(0.0, value_ms)

    def set_jitter(self, value_ms: float) -> None:
        self.jitter_ms = max(0.0, value_ms)

    def block_partition(self, partition: str) -> None:
        self.blocked_partitions.add(partition)

    def unblock_partition(self, partition: str) -> None:
        self.blocked_partitions.discard(partition)
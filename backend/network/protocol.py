"""SkyMesh network protocol — UDP message types and helpers.

All aircraft-to-aircraft messages are JSON-encoded datagrams broadcast
over a local multicast group. Receivers filter by `target` and by
communication range. The protocol intentionally stays small.

Message types:
    HELLO               node announces itself on join
    STATE_UPDATE        periodic broadcast of local state
    HEARTBEAT           liveness signal
    CONFLICT_ALERT      A tells B that a conflict was detected
    TRAJECTORY_PROPOSAL A proposes a maneuver to B
    TRAJECTORY_ACCEPT   B accepts A's proposal
    TRAJECTORY_REJECT   B rejects A's proposal
    TRAJECTORY_COMMIT   A commits to a new trajectory (informs all)
    EMERGENCY           A declares emergency priority
"""

from __future__ import annotations

import json
from typing import Any

HELLO = "HELLO"
STATE_UPDATE = "STATE_UPDATE"
HEARTBEAT = "HEARTBEAT"
CONFLICT_ALERT = "CONFLICT_ALERT"
TRAJECTORY_PROPOSAL = "TRAJECTORY_PROPOSAL"
TRAJECTORY_ACCEPT = "TRAJECTORY_ACCEPT"
TRAJECTORY_REJECT = "TRAJECTORY_REJECT"
TRAJECTORY_COMMIT = "TRAJECTORY_COMMIT"
EMERGENCY = "EMERGENCY"

ALL_TYPES = (
    HELLO,
    STATE_UPDATE,
    HEARTBEAT,
    CONFLICT_ALERT,
    TRAJECTORY_PROPOSAL,
    TRAJECTORY_ACCEPT,
    TRAJECTORY_REJECT,
    TRAJECTORY_COMMIT,
    EMERGENCY,
)


def message(msg_type: str, sender: str, **fields: Any) -> dict[str, Any]:
    msg: dict[str, Any] = {"type": msg_type, "sender": sender}
    msg.update(fields)
    return msg


def state_update(
    sender: str,
    sim_time: float,
    position: tuple[float, float, float],
    velocity: tuple[float, float, float],
    heading: float,
    speed: float,
    vertical_rate: float,
    destination: tuple[float, float, float],
    priority: int,
    emergency: bool,
    trajectory_version: int,
    plan: list[tuple[float, float, float]],
    *,
    phase: str | None = None,
    wake: str | None = None,
    origin_aid: str | None = None,
    dest_aid: str | None = None,
) -> dict[str, Any]:
    return message(
        STATE_UPDATE,
        sender,
        sim_time=sim_time,
        position=list(position),
        velocity=list(velocity),
        heading=heading,
        speed=speed,
        vertical_rate=vertical_rate,
        destination=list(destination),
        priority=priority,
        emergency=emergency,
        trajectory_version=trajectory_version,
        plan=plan,
        phase=phase,
        wake=wake,
        origin_aid=origin_aid,
        dest_aid=dest_aid,
    )


def encode(msg: dict[str, Any]) -> bytes:
    return json.dumps(msg, separators=(",", ":")).encode("utf-8")


def decode(raw: bytes) -> dict[str, Any]:
    return json.loads(raw.decode("utf-8"))
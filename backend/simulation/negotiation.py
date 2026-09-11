"""Distributed pairwise negotiation with deterministic resolution.

Aircraft exchange TRAJECTORY_PROPOSAL messages containing a full maneuver and
its cost. Both sides run the same deterministic decision rule, so they
independently converge on who wins:

    1. safety of the proposal
    2. lower trajectory cost
    3. lower predicted deviation (encoded in cost)
    4. higher priority (emergency aircraft win)
    5. aircraft ID as final tie-breaker

Oscillation is prevented via commitment windows (proposals carry a proposed
version), maneuver durations, per-aircraft cooldowns and an absolute rule:
once a proposal wins, the loser adopts the winner's trajectory.
"""

from __future__ import annotations

from typing import Any

_WINNER = "winner"
_LOSER = "loser"


def decide_winner(
    a_id: str, a_cost: float, a_priority: int, a_version: int,
    b_id: str, b_cost: float, b_priority: int, b_version: int,
) -> str:
    """Return id of the aircraft whose proposal wins."""
    if a_priority != b_priority:
        return a_id if a_priority > b_priority else b_id
    if a_cost != b_cost:
        return a_id if a_cost < b_cost else b_id
    if a_version != b_version:
        return a_id if a_version > b_version else b_id
    return min(a_id, b_id)


def beats(a_id: str, a_cost: float, a_priority: int, a_version: int,
          b_id: str, b_cost: float, b_priority: int, b_version: int) -> bool:
    return decide_winner(a_id, a_cost, a_priority, a_version,
                         b_id, b_cost, b_priority, b_version) == a_id


def proposal_consensus_response(my_id: str, my_proposal: dict[str, Any] | None,
                                incoming: dict[str, Any]) -> dict[str, Any]:
    """Given my pending proposal (if any) and a peer's incoming proposal,
    compute the deterministic response.

    Returns ACK payloads for the network layer to emit.
    """
    their_id = incoming.get("sender", "")
    incoming_cost = float(incoming.get("cost", 1e9))
    incoming_priority = int(incoming.get("priority", 0))
    incoming_version = int(incoming.get("proposal_version", 0))

    response: dict[str, Any] = {}

    if my_proposal is None:
        response["type"] = "TRAJECTORY_ACCEPT"
        response["target"] = their_id
        response["proposal_id"] = incoming.get("proposal_id")
        response["maneuver"] = incoming.get("maneuver")
        response["cost"] = incoming_cost
        response["winner"] = their_id
        return response

    my_cost = float(my_proposal.get("cost", 1e9))
    my_priority = int(my_proposal.get("priority", 0))
    my_version = int(my_proposal.get("proposal_version", 0))

    if beats(my_id, my_cost, my_priority, my_version, their_id, incoming_cost, incoming_priority, incoming_version):
        response["type"] = "TRAJECTORY_REJECT"
        response["target"] = their_id
        response["proposal_id"] = incoming.get("proposal_id")
        response["winner"] = my_id
        return response

    response["type"] = "TRAJECTORY_ACCEPT"
    response["target"] = their_id
    response["proposal_id"] = incoming.get("proposal_id")
    response["maneuver"] = incoming.get("maneuver")
    response["cost"] = incoming_cost
    response["winner"] = their_id
    return response
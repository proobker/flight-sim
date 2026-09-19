"""Terminal controller — wake-turbulence sequencing per runway.

A single Tower object plays the role real ATC sits in at each airport.
Inbounds report in as they start their pattern descent and are assigned a
time slot; the tower spaces consecutive landings by ICAO wake-turbulence
gaps and gates departures so they never roll out into an aircraft on final.
Go-arounds are given immediate re-entry priority.

En-route separation stays fully decentralised; the tower only owns the
terminal area — which is exactly how the real world does it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..simulation.fleet import WAKE_HEAVY, WAKE_LIGHT, WAKE_MEDIUM

PENDING = "pending"
LANDED = "landed"
ABORTED = "aborted"

# Seconds a departing aircraft needs before the runway is free for a landing.
RUNWAY_CLEAR_AFTER_DEPARTURE = 120.0
# Seconds a landing aircraft occupies the runway on rollout/turn-off.
RUNWAY_CLEAR_AFTER_LANDING = 90.0


@dataclass
class Slot:
    """One sequenced arrival on a runway."""

    aid: str
    runway: str
    wake: str
    eta: float
    open_at: float
    status: str = PENDING


def wake_gap(follow: str, lead: str) -> float:
    """Time separation (s) between two consecutive landings on one runway."""
    if lead == WAKE_HEAVY:
        if follow == WAKE_LIGHT:
            return 240.0
        if follow == WAKE_MEDIUM:
            return 180.0
        return 150.0
    if lead == WAKE_MEDIUM:
        return 150.0 if follow == WAKE_LIGHT else 120.0
    return 120.0


def departure_gap(follow: str, lead: str) -> float:
    """Time separation (s) between two consecutive takeoff rolls."""
    if lead == WAKE_HEAVY and follow == WAKE_LIGHT:
        return 150.0
    if lead == WAKE_HEAVY:
        return 120.0
    return 90.0 if follow == WAKE_LIGHT else 60.0


class TerminalController:
    """Shared, single-threaded (asyncio) airport tower for terminal ops."""

    def __init__(self) -> None:
        self._slots: dict[str, list[Slot]] = {}
        self._last_departure: dict[str, tuple[float, str] | None] = {}
        self._runway_busy_until: dict[str, float] = {}

    # ----- arrivals -----
    def request_final(
        self,
        aid: str,
        runway: str,
        wake: str,
        eta: float,
        now: float,
        reenter: bool = False,
    ) -> float:
        """Register an inbound and return the sim-time its slot opens."""
        slots = self._slots.setdefault(runway, [])
        if reenter:
            slots = [s for s in slots if not (s.aid == aid and s.status == PENDING)]
            self._slots[runway] = slots
        slots.append(Slot(aid=aid, runway=runway, wake=wake, eta=max(eta, now), open_at=max(eta, now)))
        slots.sort(key=lambda s: s.eta)
        # Re-chain the wake gaps in ETA order; the tower sequences arrivals.
        prev_open = float("-inf")
        prev_wake: str | None = None
        for s in slots:
            if s.status == ABORTED:
                continue
            if prev_wake is not None:
                s.open_at = max(s.eta, prev_open + wake_gap(s.wake, prev_wake))
            else:
                s.open_at = s.eta
            if s.aid == aid:
                slot = s
            prev_open = s.open_at
            prev_wake = s.wake
        return slot.open_at if "slot" in locals() else max(eta, now)

    def slot_open(self, aid: str, runway: str, now: float) -> bool:
        for s in self._slots.get(runway, []):
            if s.aid == aid and s.status == PENDING:
                return now >= s.open_at and now >= self._runway_busy_until.get(runway, 0.0)
        return False

    def landing_blocked(self, aid: str, runway: str, now: float) -> bool:
        """True when a departure is still occupying the runway."""
        return now < self._runway_busy_until.get(runway, 0.0)

    def note_landed(self, aid: str, runway: str, now: float) -> None:
        for s in self._slots.get(runway, []):
            if s.aid == aid:
                s.status = LANDED
        self._runway_busy_until[runway] = now + RUNWAY_CLEAR_AFTER_LANDING

    def request_go_around(
        self,
        aid: str,
        runway: str,
        wake: str,
        eta: float,
        now: float,
    ) -> float:
        """Aborts the old slot and gives the aircraft immediate re-entry."""
        slots = self._slots.setdefault(runway, [])
        for s in slots:
            if s.aid == aid and s.status == PENDING:
                s.status = ABORTED
        return self.request_final(aid, runway, wake, eta, now, reenter=True)

    # ----- departures -----
    def clear_for_departure(self, aid: str, runway: str, wake: str, now: float) -> bool:
        """May this aircraft begin its takeoff roll? Clears iff the stack is quiet."""
        if now < self._runway_busy_until.get(runway, 0.0):
            return False
        last = self._last_departure.get(runway)
        if last is not None and now - last[0] < departure_gap(wake, last[1]):
            return False
        # Do not start a departure that would still be rolling as the next
        # arrival reaches the runway — let the arrival land first.
        for s in self._slots.get(runway, []):
            if s.status == PENDING and s.aid != aid:
                if now < s.open_at < now + 200.0:
                    return False
        self._last_departure[runway] = (now, wake)
        self._runway_busy_until[runway] = now + RUNWAY_CLEAR_AFTER_DEPARTURE
        return True

    def note_departure(self, aid: str, runway: str, wake: str, now: float) -> None:
        """Takeoff roll has begun; the runway must stay free for it."""
        self._last_departure.setdefault(runway, (now, wake))
        self._runway_busy_until[runway] = now + RUNWAY_CLEAR_AFTER_DEPARTURE

    def note_departure_airborne(self, runway: str, now: float) -> None:
        """The departure is climbing out; landing may use the runway again."""
        self._runway_busy_until[runway] = now + 1.0

    # ----- inspection -----
    def slots(self, runway: str) -> list[dict[str, Any]]:
        return [
            {
                "aid": s.aid,
                "wake": s.wake,
                "eta": round(s.eta, 1),
                "open_at": round(s.open_at, 1),
                "status": s.status,
            }
            for s in self._slots.get(runway, [])
        ]
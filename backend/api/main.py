"""FastAPI server — REST control endpoints + WebSocket stream + static frontend."""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import sys
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from ..engine.simulator import SimConfig, Simulator

APP_VERSION = "0.3.0"
FRONTEND_DIST = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend",
    "dist",
)
HAS_FRONTEND = os.path.isdir(FRONTEND_DIST)

app = FastAPI(title="SkyMesh", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup_install_exception_handler():
    await _install_exception_handler()


sim: Simulator | None = None
_connected: list[WebSocket] = []


def _compress(payload: bytes) -> bytes:
    return gzip.compress(payload, compresslevel=9)


def get_sim() -> Simulator:
    if sim is None:
        raise HTTPException(status_code=503, detail="Simulator not initialised")
    return sim


# ────────── lifecycle ──────────

# Windows asyncio quirk: when a TCP/WebSocket client disconnects abruptly the
# proactor transport's _call_connection_lost() cleanup calls
# self._sock.shutdown() on an already-closed socket, raising
# ConnectionResetError/WinError 10054 (or 10038). It's harmless loop noise,
# so we filter exactly those codes and pass everything else to the default
# handler.
def _quiet_windows_proactor_noise(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
    exception = context.get("exception")
    if sys.platform == "win32" and isinstance(exception, OSError):
        code = getattr(exception, "winerror", None) or getattr(exception, "errno", None)
        if code in (10054, 10038):
            return
    asyncio.events.default_exception_handler(loop, context)


async def _install_exception_handler() -> None:
    asyncio.get_running_loop().set_exception_handler(_quiet_windows_proactor_noise)


async def init_simulator(config: SimConfig | None = None, seed: int | None = None) -> None:
    global sim
    sim = Simulator(config)
    if seed is not None:
        sim._rng.seed(seed)
    sim.on_snapshot(_broadcast_snapshot)
    await sim.start()


async def shutdown_simulator() -> None:
    global sim
    if sim is not None:
        await sim.stop()
        sim = None


# ────────── REST endpoints ──────────

if not HAS_FRONTEND:

    @app.get("/")
    async def root():
        return {"name": "SkyMesh", "version": APP_VERSION, "status": "running"}


@app.get("/api/state")
async def get_state():
    return get_sim().snapshot()


@app.get("/api/terrain")
async def terrain_metadata():
    """Terrain grid metadata (bounds, resolution, elevation range)."""
    terrain = get_sim().airspace.terrain
    if terrain is None:
        return {"enabled": False}
    return {"enabled": True, **terrain.metadata()}


@app.get("/api/terrain/grid")
async def terrain_grid():
    """The Float32 elevation grid (gzip'd) — fetched once by the frontend."""
    terrain = get_sim().airspace.terrain
    if terrain is None:
        return Response(content=b"", media_type="application/octet-stream", status_code=404)
    payload = terrain.to_bytes()
    compressed = _compress(payload)
    return Response(
        content=compressed,
        media_type="application/octet-stream",
        headers={
            "Content-Encoding": "gzip",
            "Cache-Control": "public, max-age=3600",
            "X-Terrain-Bytes": str(len(payload)),
            "X-Terrain-Cells": f"{terrain.width}x{terrain.height}",
        },
    )


@app.post("/api/control/kill")
async def kill_aircraft(data: dict[str, Any] | None = None):
    aid = (data or {}).get("id")
    if not isinstance(aid, str) or not aid:
        raise HTTPException(status_code=422, detail="'id' (non-empty string) is required")
    ok = await get_sim().kill_aircraft(aid)
    return {"ok": ok}


def _valid_count(value: Any, name: str = "count", minimum: int = 0, maximum: int = 500) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise HTTPException(status_code=422, detail=f"'{name}' must be an integer")
    if not minimum <= value <= maximum:
        raise HTTPException(status_code=422, detail=f"'{name}' must be in [{minimum}, {maximum}]")
    return value


@app.post("/api/control/kill_random")
async def kill_random(data: dict[str, Any] | None = None):
    count = _valid_count((data or {}).get("count", 5), maximum=500)
    ids = await get_sim().kill_random(count)
    return {"killed": ids}


@app.post("/api/control/spawn_emergency")
async def spawn_emergency():
    agent = await get_sim().spawn_emergency()
    return {"id": agent.id}


@app.post("/api/control/partition")
async def partition_network():
    parts = get_sim().partition_network()
    return {"partitions": parts}


@app.post("/api/control/rejoin")
async def rejoin_network():
    get_sim().rejoin_network()
    return {"ok": True}


@app.post("/api/control/packet_loss")
async def set_packet_loss(data: dict[str, Any] | None = None):
    value = (data or {}).get("value", 0.0)
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="'value' must be numeric")
    if not 0.0 <= value <= 1.0:
        raise HTTPException(status_code=422, detail="'value' must be in [0.0, 1.0]")
    get_sim().set_packet_loss(value)
    return {"ok": True}


@app.post("/api/control/latency")
async def set_latency(data: dict[str, Any] | None = None):
    ms = (data or {}).get("ms", 0.0)
    try:
        ms = float(ms)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="'ms' must be numeric")
    if ms < 0.0:
        raise HTTPException(status_code=422, detail="'ms' must be non-negative")
    get_sim().set_latency(ms)
    return {"ok": True}


@app.post("/api/control/storm")
async def add_storm():
    get_sim().add_storm()
    return {"ok": True}


@app.post("/api/control/close_airport")
async def close_airport(data: dict[str, Any] | None = None):
    aid = (data or {}).get("aid")
    target = get_sim().close_airport(aid)
    return {"ok": True, "aid": target.aid if target else None}


@app.post("/api/control/add_nofly")
async def add_nofly():
    get_sim().add_nofly()
    return {"ok": True}


@app.post("/api/control/traffic")
async def add_traffic(data: dict[str, Any] | None = None):
    count = _valid_count((data or {}).get("count", 10), maximum=500)
    await get_sim()._spawn_aircraft(count)
    return {"ok": True}


# ────────── WebSocket ──────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    _connected.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in _connected:
            _connected.remove(websocket)


def _broadcast_snapshot(snapshot: dict[str, Any]) -> None:
    payload = json.dumps(snapshot, separators=(",", ":"))
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    for ws in list(_connected):
        loop.create_task(_safe_send(ws, payload))


async def _safe_send(ws: WebSocket, payload: str) -> None:
    try:
        await ws.send_text(payload)
    except Exception:
        pass


# ────────── static frontend (mounted last so /api and /ws win) ──────────

if HAS_FRONTEND:
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="app")
"""FastAPI server — REST control endpoints + WebSocket stream."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from ..engine.simulator import SimConfig, Simulator

app = FastAPI(title="SkyMesh", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

sim: Simulator | None = None
_connected: list[WebSocket] = []


def get_sim() -> Simulator:
    assert sim is not None, "Simulator not initialised"
    return sim


# ────────── lifecycle ──────────

async def init_simulator(config: SimConfig | None = None) -> None:
    global sim
    sim = Simulator(config)
    sim.on_snapshot(_broadcast_snapshot)
    await sim.start()


async def shutdown_simulator() -> None:
    global sim
    if sim is not None:
        await sim.stop()
        sim = None


# ────────── REST endpoints ──────────

@app.get("/")
async def root():
    return {"name": "SkyMesh", "version": "0.1.0", "status": "running"}


@app.get("/api/state")
async def get_state():
    return get_sim().snapshot()


@app.post("/api/control/kill")
async def kill_aircraft(data: dict[str, Any]):
    ok = await get_sim().kill_aircraft(data["id"])
    return {"ok": ok}


@app.post("/api/control/kill_random")
async def kill_random(data: dict[str, Any] | None = None):
    count = (data or {}).get("count", 5)
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
async def set_packet_loss(data: dict[str, Any]):
    get_sim().set_packet_loss(float(data.get("value", 0.0)))
    return {"ok": True}


@app.post("/api/control/latency")
async def set_latency(data: dict[str, Any]):
    get_sim().set_latency(float(data.get("ms", 0.0)))
    return {"ok": True}


@app.post("/api/control/storm")
async def add_storm():
    get_sim().add_storm()
    return {"ok": True}


@app.post("/api/control/close_airport")
async def close_airport():
    get_sim().close_airport()
    return {"ok": True}


@app.post("/api/control/add_nofly")
async def add_nofly():
    get_sim().add_nofly()
    return {"ok": True}


@app.post("/api/control/traffic")
async def add_traffic(data: dict[str, Any] | None = None):
    count = (data or {}).get("count", 10)
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
    for ws in list(_connected):
        try:
            asyncio.get_event_loop().create_task(ws.send_text(payload))
        except Exception:
            pass
"""SkyMesh entry point.

Usage (from repo root):
    python -m backend.run                      headless simulation
    python -m backend.run --serve              FastAPI server + background sim
    python -m backend.run --aircraft 100       configure aircraft count
"""

from __future__ import annotations

import argparse
import json
import time


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SkyMesh simulation")
    p.add_argument("--serve", action="store_true", help="run FastAPI server with background sim")
    p.add_argument("--aircraft", type=int, default=50, help="number of aircraft")
    p.add_argument("--tick-rate", type=float, default=20.0, help="simulation ticks/sec")
    p.add_argument("--sim-speed", type=float, default=2.0, help="time multiplier")
    p.add_argument("--seconds", type=float, default=10.0, help="headless run duration")
    p.add_argument("--seed", type=int, default=42, help="random seed")
    p.add_argument("--terrain-seed", type=int, default=1337, help="terrain generation seed (None disables terrain)")
    p.add_argument("--host", default="127.0.0.1", help="server host")
    p.add_argument("--port", type=int, default=8000, help="server port")
    return p.parse_args()


async def run_headless(args: argparse.Namespace) -> None:
    from .engine.simulator import SimConfig, Simulator

    config = SimConfig(
        num_aircraft=args.aircraft,
        tick_rate=args.tick_rate,
        sim_speed=args.sim_speed,
        terrain_seed=args.terrain_seed,
    )
    sim = Simulator(config)
    sim._rng.seed(args.seed)
    await sim.start()
    print(f"[skymesh] started {args.aircraft} aircraft (headless)")
    deadline = time.time() + args.seconds
    snap = None
    while time.time() < deadline:
        await asyncio_sleep(0.5)
        snap = sim.snapshot()
    await sim.stop()
    print(json.dumps(sim.metrics.as_dict(), indent=2))
    if snap:
        print(json.dumps({k: v for k, v in snap.items() if k != "aircraft"}, indent=2))


def asyncio_sleep(seconds: float):
    import asyncio

    return asyncio.sleep(seconds)


def run_server(args: argparse.Namespace) -> None:
    import uvicorn
    from .api.main import app, init_simulator, shutdown_simulator
    from .engine.simulator import SimConfig

    config = SimConfig(
        num_aircraft=args.aircraft,
        tick_rate=args.tick_rate,
        sim_speed=args.sim_speed,
        terrain_seed=args.terrain_seed,
    )

    @app.on_event("startup")
    async def _startup():
        await init_simulator(config)

    @app.on_event("shutdown")
    async def _shutdown():
        await shutdown_simulator()

    uvicorn.run(app, host=args.host, port=args.port)


def main() -> None:
    args = parse_args()
    if args.serve:
        run_server(args)
    else:
        import asyncio

        asyncio.run(run_headless(args))


if __name__ == "__main__":
    main()
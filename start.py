"""SkyMesh all-in-one launcher.

One command builds the frontend (when needed) and runs the backend server,
which serves the whole stack — UI, REST API and WebSocket — on a single port.

Usage (from repo root):
    python start.py                # serve everything on http://127.0.0.1:8000/
    python start.py --build        # force a frontend rebuild before serving
    python start.py --aircraft 100 --port 9000
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.join(ROOT, "frontend", "dist", "index.html")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SkyMesh all-in-one launcher")
    p.add_argument("--build", action="store_true", help="force a frontend rebuild")
    p.add_argument("--aircraft", type=int, default=60, help="number of aircraft")
    p.add_argument("--tick-rate", type=float, default=12.0, help="simulation ticks/sec")
    p.add_argument("--sim-speed", type=float, default=1.0, help="time multiplier")
    p.add_argument("--host", default="127.0.0.1", help="server host")
    p.add_argument("--port", type=int, default=8000, help="server port")
    return p.parse_args()


def build_frontend() -> None:
    print("[start] building frontend (npm --prefix frontend run build) ...")
    cmd = ["npm", "--prefix", "frontend", "run", "build"]
    try:
        result = subprocess.run(cmd, cwd=ROOT)
    except FileNotFoundError:
        print("[start] npm not found — starting server without a rebuilt frontend.")
        return
    if result.returncode != 0:
        print("[start] frontend build failed; the UI may not load.")
    else:
        print("[start] frontend built.")


def main() -> None:
    args = parse_args()
    if args.build or not os.path.isfile(FRONTEND_DIST):
        build_frontend()

    print(f"[start] starting SkyMesh at http://{args.host}:{args.port}/")
    cmd = [
        sys.executable,
        "-m",
        "backend.run",
        "--serve",
        "--aircraft",
        str(args.aircraft),
        "--tick-rate",
        str(args.tick_rate),
        "--sim-speed",
        str(args.sim_speed),
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]
    raise SystemExit(subprocess.run(cmd, cwd=ROOT).returncode)


if __name__ == "__main__":
    main()
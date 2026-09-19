"""SkyMesh dev launcher — backend + Vite in one command.

Spawns the FastAPI backend (REST + WebSocket + sim) on 8000 and the Vite dev
server on 5173 (which proxies /api and /ws to the backend). Frontend edits
hot-reload; both processes are torn down together on Ctrl+C.

Usage (from repo root):
    python start_dev.py                # http://localhost:5173 (UI) + :8000 (API)
    python start_dev.py --vite-port 5180
    python start_dev.py --aircraft 100
"""

from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VITE_PORT = 5173

NPM = shutil.which("npm.cmd") if os.name == "nt" else shutil.which("npm")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SkyMesh dev launcher")
    p.add_argument("--aircraft", type=int, default=60, help="number of aircraft")
    p.add_argument("--tick-rate", type=float, default=12.0, help="simulation ticks/sec")
    p.add_argument("--sim-speed", type=float, default=1.0, help="time multiplier")
    p.add_argument("--host", default="127.0.0.1", help="backend host")
    p.add_argument("--port", type=int, default=8000, help="backend port")
    p.add_argument("--vite-port", type=int, default=DEFAULT_VITE_PORT, help="Vite dev server port")
    return p.parse_args()


def port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.3):
            return True
    except OSError:
        return False


def wait_for_port(host: str, port: int, label: str, timeout: float = 40.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(host, port):
            print(f"[start_dev] {label} ready on http://{host}:{port}/")
            return
        time.sleep(0.5)
    raise RuntimeError(f"[start_dev] {label} did not start on {host}:{port} in time")


def kill_proc(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> None:
    args = parse_args()
    if NPM is None:
        raise SystemExit("[start_dev] npm not found — install Node.js (npm) first.")

    backend = subprocess.Popen(
        [
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
        ],
        cwd=ROOT,
    )
    vite = subprocess.Popen(
        [
            NPM,
            "--prefix",
            "frontend",
            "run",
            "dev",
            "--",
            "--port",
            str(args.vite_port),
            "--strictPort",
            "--host",
            "localhost",
        ],
        cwd=ROOT,
    )

    try:
        wait_for_port(args.host, args.port, "backend")
        wait_for_port("localhost", args.vite_port, "frontend")
        print()
        print(f"[start_dev] UI    -> http://localhost:{args.vite_port}/")
        print(f"[start_dev] API   -> http://{args.host}:{args.port}/docs")
        print("[start_dev] Ctrl+C to stop both.")
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[start_dev] stopping ...")
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
    finally:
        kill_proc(vite)
        kill_proc(backend)
        print("[start_dev] stopped.")


if __name__ == "__main__":
    main()
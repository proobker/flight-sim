import { useEffect, useRef, useState } from "react";
import type { SimSnapshot } from "../api/types";

/**
 * Hook to connect to the SkyMesh WebSocket stream.
 * Returns the latest snapshot and connection status.
 */
export function useSimulationSocket(): {
  snapshot: SimSnapshot | null;
  connected: boolean;
} {
  const [connected, setConnected] = useState(false);
  const snapshotRef = useRef<SimSnapshot | null>(null);
  const [, forceRender] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (alive) setConnected(true);
        // Keep the connection (and hosted free tiers that sleep on inbound
        // inactivity) awake with a lightweight client-to-server heartbeat.
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 30000);
      };

      ws.onmessage = (ev) => {
        try {
          snapshotRef.current = JSON.parse(ev.data);
          forceRender((n) => n + 1);
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (alive) {
          setConnected(false);
          retryTimeout = setTimeout(connect, 1500);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      alive = false;
      clearTimeout(retryTimeout);
      if (heartbeat) clearInterval(heartbeat);
      wsRef.current?.close();
    };
  }, []);

  return { snapshot: snapshotRef.current, connected };
}
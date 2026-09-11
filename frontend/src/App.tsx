import { useEffect, useRef, useState } from "react";
import { useSimulationSocket } from "./hooks/useSimulationSocket";
import { SkyScene } from "./visualization/SkyScene";
import { Dashboard } from "./components/Dashboard";
import { ControlPanel } from "./components/ControlPanel";

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkyScene | null>(null);
  const { snapshot, connected } = useSimulationSocket();

  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || sceneRef.current) return;
    sceneRef.current = new SkyScene(containerRef.current);
    setSceneReady(true);
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (snapshot && sceneRef.current) {
      sceneRef.current.update(snapshot);
    }
  }, [snapshot]);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          padding: "2px 10px",
          borderRadius: 20,
          font: "11px/2 monospace",
          color: connected ? "#7dffb0" : "#ff8899",
          background: "#0a0e1c88",
          border: `1px solid ${connected ? "#1f7a44" : "#7a2430"}`,
        }}
      >
        {connected ? "● LIVE" : "○ RECONNECTING"}
      </div>

      {sceneReady && (
        <>
          <Dashboard snapshot={snapshot} />
          <ControlPanel />
        </>
      )}
    </div>
  );
}
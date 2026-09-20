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
  const [dayMode, setDayMode] = useState(false);
  const [showConflicts, setShowConflicts] = useState(true);
  const [showTags, setShowTags] = useState(true);

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
    sceneRef.current?.setOptions({ dayMode, showConflicts, showTags });
  }, [dayMode, showConflicts, showTags]);

  useEffect(() => {
    if (snapshot && sceneRef.current) {
      sceneRef.current.update(snapshot);
    }
  }, [snapshot]);

  const handleReset = () => {
    setDayMode(false);
    setShowConflicts(true);
    setShowTags(true);
    sceneRef.current?.resetView();
  };

  const handleCloseAirport = (aid: string) => {
    fetch("/api/control/close_airport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aid }),
    }).catch((e) => console.error("close airport failed", aid, e));
  };

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          padding: "3px 12px",
          borderRadius: 3,
          font: "11px/1.6 'Consolas', 'Courier New', monospace",
          letterSpacing: "1px",
          color: connected ? "#33ff88" : "#ff6644",
          background: "#0c1218cc",
          border: `1px solid ${connected ? "#1a5a3a" : "#5a2218"}`,
          textTransform: "uppercase",
        }}
      >
        {connected ? "● LIVE" : "○ RECONNECTING"}
      </div>

      {sceneReady && (
        <>
          <Dashboard
            snapshot={snapshot}
            dayMode={dayMode}
            setDayMode={setDayMode}
            showConflicts={showConflicts}
            setShowConflicts={setShowConflicts}
            showTags={showTags}
            setShowTags={setShowTags}
            onReset={handleReset}
            onCloseAirport={handleCloseAirport}
          />
          <ControlPanel />
        </>
      )}
    </div>
  );
}
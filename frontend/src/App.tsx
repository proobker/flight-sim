import { useEffect, useRef, useState } from "react";
import { useSimulationSocket } from "./hooks/useSimulationSocket";
import { SkyScene } from "./visualization/SkyScene";
import { Dashboard } from "./components/Dashboard";
import { ControlPanel } from "./components/ControlPanel";
import { Landing } from "./components/Landing";

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkyScene | null>(null);
  const { snapshot, connected } = useSimulationSocket();

  const [phase, setPhase] = useState<"landing" | "demo">("landing");
  const [leaving, setLeaving] = useState(false);
  const [dayMode, setDayMode] = useState(false);
  const [showConflicts, setShowConflicts] = useState(true);
  const [showTags, setShowTags] = useState(true);
  const [, setTick] = useState(0);

  // Boot the sim immediately so terrain, aircraft model, and the live stream
  // all preload while the user is still on the landing page.
  useEffect(() => {
    if (!containerRef.current || sceneRef.current) return;
    sceneRef.current = new SkyScene(containerRef.current);
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Poll load status while the landing page is visible (sky-scene getters are
  // plain flags, not React state).
  useEffect(() => {
    if (phase !== "landing") return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    sceneRef.current?.setOptions({ dayMode, showConflicts, showTags });
  }, [dayMode, showConflicts, showTags]);

  useEffect(() => {
    if (snapshot && sceneRef.current) {
      sceneRef.current.update(snapshot);
    }
  }, [snapshot]);

  const handleStart = () => {
    setLeaving(true);
    window.setTimeout(() => setPhase("demo"), 320);
  };

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

      {phase === "landing" && (
        <Landing
          leaving={leaving}
          connected={connected}
          snapshotReady={!!snapshot}
          modelReady={sceneRef.current?.modelReady ?? false}
          terrainLoaded={sceneRef.current?.terrainLoaded ?? false}
          liveCount={snapshot?.active ?? 0}
          onStart={handleStart}
        />
      )}

      {phase === "demo" && (
        <>
          <div
            style={{
              position: "absolute",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
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
import { memo } from "react";

const features = [
  "Live aircraft stream over WebSocket",
  "Terrain-aware flight deck & TAWS warnings",
  "Real-time conflict detection & resolution",
];

const statusStyle: React.CSSProperties = {
  display: "flex",
  gap: 16,
  justifyContent: "center",
  fontFamily: "'Consolas', 'Courier New', monospace",
  fontSize: 11,
  letterSpacing: "1px",
  color: "#779966",
  textTransform: "uppercase",
};

const statusItem = (ok: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: ok ? "#33ff88" : "#556644",
  textShadow: ok ? "0 0 8px rgba(51, 255, 136, 0.4)" : "none",
});

function StatusItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span style={statusItem(ok)}>
      <span>{ok ? "\u2714" : "\u25CB"}</span>
      {label}
    </span>
  );
}

export const Landing = memo(function Landing({
  leaving,
  connected,
  snapshotReady,
  modelReady,
  terrainLoaded,
  onStart,
}: {
  leaving: boolean;
  connected: boolean;
  snapshotReady: boolean;
  modelReady: boolean;
  terrainLoaded: boolean;
  onStart: () => void;
}) {
  return (
    <div className={`landing${leaving ? " leaving" : ""}`}>
      <div className="landing-scrim" />

      <div className="landing-radar">
        <div className="radar-sweep" />
        <div className="radar-ring r1" />
        <div className="radar-ring r2" />
        <div className="radar-ring r3" />
        <div className="radar-core" />
      </div>

      <div className="landing-content">
        <h1 className="landing-title">
          SKY<span>MESH</span>
        </h1>
        <p className="landing-sub">AERIAL TRAFFIC CONTROL &middot; FLIGHT SIMULATION</p>

        <ul className="landing-features">
          {features.map((f) => (
            <li key={f}>
              <span className="landing-bullet">&#9656;</span> {f}
            </li>
          ))}
        </ul>

        <button className="get-started" onClick={onStart} autoFocus>
          GET STARTED&nbsp; &#9654;
        </button>

        <div style={statusStyle}>
          <StatusItem label="SOCKET" ok={connected} />
          <StatusItem label="AIRCRAFT" ok={modelReady} />
          <StatusItem label="TERRAIN" ok={terrainLoaded} />
          <StatusItem label="STREAM" ok={snapshotReady} />
        </div>
      </div>
    </div>
  );
});
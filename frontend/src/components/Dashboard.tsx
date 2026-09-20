import type { SimSnapshot, Airport, Runway } from "../api/types";

const metricStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 11,
  padding: "2px 0",
  fontFamily: "'Consolas', 'Courier New', monospace",
  letterSpacing: "0.5px",
};

const labelStyle: React.CSSProperties = { color: "#779966" };
const valueStyle: React.CSSProperties = { color: "#33ff88", fontVariantNumeric: "tabular-nums", fontWeight: 600 };

const toggleRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 11,
  padding: "4px 0",
  fontFamily: "'Consolas', 'Courier New', monospace",
  letterSpacing: "0.5px",
  color: "#779966",
};

const toggleTrack = (on: boolean): React.CSSProperties => ({
  width: 32,
  height: 16,
  borderRadius: 8,
  background: on ? "#1a5a3a" : "#2a1a1a",
  border: `1px solid ${on ? "#33ff88" : "#553333"}`,
  position: "relative",
  cursor: "pointer",
  transition: "all 0.2s ease",
  flexShrink: 0,
});

const toggleKnob = (on: boolean): React.CSSProperties => ({
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: on ? "#33ff88" : "#664444",
  position: "absolute",
  top: 2,
  left: on ? 18 : 2,
  transition: "all 0.2s ease",
  boxShadow: on ? "0 0 6px #33ff88" : "none",
});

export function Dashboard({
  snapshot,
  dayMode,
  setDayMode,
  showConflicts,
  setShowConflicts,
  showTags,
  setShowTags,
  onReset,
}: {
  snapshot: SimSnapshot | null;
  dayMode: boolean;
  setDayMode: (v: boolean) => void;
  showConflicts: boolean;
  setShowConflicts: (v: boolean) => void;
  showTags: boolean;
  setShowTags: (v: boolean) => void;
  onReset: () => void;
}) {
  if (!snapshot) {
    return (
      <div className="panel dashboard">
        <h2>SKYMESH</h2>
        <p style={{ color: "#556644", fontFamily: "'Consolas', monospace", fontSize: 11 }}>
          Waiting for stream...
        </p>
      </div>
    );
  }

  const windVec = snapshot.wind?.vector ?? null;
  const terrain = snapshot.airspace.terrain;
  const taws = snapshot.aircraft.filter((a) => a.active && a.terrain_warning).length;
  const runwayRating = (r: Runway): number => {
    if (!windVec) return 0;
    return -(windVec[0] * Math.sin(r.heading) + windVec[1] * Math.cos(r.heading));
  };
  const activeRunway = (a: Airport): Runway | null => {
    if (!a.runways.length) return null;
    return [...a.runways].sort((p, q) => runwayRating(q) - runwayRating(p))[0];
  };
  const inbound = (a: Airport): number =>
    snapshot.aircraft.filter((x) => x.active && x.dest_aid === a.id).length;
  const runwayRow = (a: Airport): string => {
    const r = activeRunway(a);
    return r
      ? `${a.name} R${r.heading_label} · ${inbound(a)} inbound`
      : `${a.name} · ${inbound(a)} inbound`;
  };
  const rows: Array<[string, string]> = [
    ["Aircraft", `${snapshot.active}/${snapshot.network_nodes_total}`],
    ["Active conflicts", `${snapshot.active_conflicts}`],
    ["Resolved", `${snapshot.conflicts_resolved}`],
    ["Detected", `${snapshot.conflicts_detected}`],
    ["Collisions", `${snapshot.collisions}`],
    ["Near misses", `${snapshot.near_misses}`],
    ["Min sep", snapshot.min_separation != null ? `${(snapshot.min_separation / 1000).toFixed(2)} km` : "---"],
    ["Avg res", `${snapshot.avg_resolution_ms.toFixed(0)} ms`],
    ["Failed", `${snapshot.nodes_failed}`],
    ["Partitions", `${snapshot.partition_events}`],
    ["Terrain", terrain ? `${Math.round(terrain.zmin)}–${Math.round(terrain.zmax)} m` : "flat"],
    ["TAWS warns", `${taws}`],
    ["Sim time", `${snapshot.time.toFixed(1)}s`],
  ];

  return (
    <div className="panel dashboard">
      <h2>SKYMESH <span className="dot">&#9679;</span></h2>
      <div>
        {rows.map(([k, v]) => (
          <div key={k} style={metricStyle}>
            <span style={labelStyle}>{k}</span>
            <span style={valueStyle}>{v}</span>
          </div>
        ))}
      </div>

      {snapshot.wind && (
        <div style={{ borderTop: "1px solid #1a3a2a", marginTop: 8, paddingTop: 6 }}>
          <div style={metricStyle}>
            <span style={labelStyle}>WIND</span>
            <span style={valueStyle}>
              {snapshot.wind.direction} · {snapshot.wind.speed.toFixed(1)} m/s
            </span>
          </div>
          {snapshot.airspace.airports.map((a) => (
            <div key={a.id} style={metricStyle}>
              <span style={labelStyle}>{"· " + a.id}</span>
              <span style={valueStyle}>{runwayRow(a)}</span>
            </div>
          ))}
        </div>
      )}

      {terrain && (
        <div style={{ borderTop: "1px solid #1a3a2a", marginTop: 8, paddingTop: 6 }}>
          <div style={metricStyle}>
            <span style={labelStyle}>TERRAIN</span>
            <span style={valueStyle}>
              {(terrain.cell * (terrain.width - 1) / 1000).toFixed(0)} km · {terrain.cell} m cells
            </span>
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid #1a3a2a", marginTop: 8, paddingTop: 6 }}>
        <div style={toggleRow}>
          <span>DAY MODE</span>
          <div style={toggleTrack(dayMode)} onClick={() => setDayMode(!dayMode)}>
            <div style={toggleKnob(dayMode)} />
          </div>
        </div>
        <div style={toggleRow}>
          <span>CONFLICTS</span>
          <div style={toggleTrack(showConflicts)} onClick={() => setShowConflicts(!showConflicts)}>
            <div style={toggleKnob(showConflicts)} />
          </div>
        </div>
        <div style={toggleRow}>
          <span>TAGS</span>
          <div style={toggleTrack(showTags)} onClick={() => setShowTags(!showTags)}>
            <div style={toggleKnob(showTags)} />
          </div>
        </div>
        <button
          onClick={onReset}
          style={{
            width: "100%",
            marginTop: 6,
            padding: "5px 0",
            background: "#0c1218",
            color: "#668888",
            border: "1px solid #1a3a2a",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "'Consolas', 'Courier New', monospace",
            fontSize: 10,
            letterSpacing: "2px",
            transition: "all 0.15s ease",
          }}
        >
          RESET
        </button>
      </div>
    </div>
  );
}

import type { SimSnapshot } from "../api/types";

const metricStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 12,
  padding: "3px 0",
};

const labelStyle: React.CSSProperties = { color: "#8899bb" };
const valueStyle: React.CSSProperties = { color: "#e8f0ff", fontVariantNumeric: "tabular-nums" };

export function Dashboard({ snapshot }: { snapshot: SimSnapshot | null }) {
  if (!snapshot) {
    return (
      <div className="panel dashboard">
        <h2>SKYMESH</h2>
        <p style={{ color: "#88a" }}>Waiting for stream…</p>
      </div>
    );
  }

  const rows: Array<[string, string]> = [
    ["Aircraft", `${snapshot.active}/${snapshot.network_nodes_total}`],
    ["Active conflicts", `${snapshot.active_conflicts}`],
    ["Resolved", `${snapshot.conflicts_resolved}`],
    ["Detected", `${snapshot.conflicts_detected}`],
    ["Collisions", `${snapshot.collisions}`],
    ["Near misses", `${snapshot.near_misses}`],
    ["Min separation", snapshot.min_separation != null ? `${(snapshot.min_separation / 1000).toFixed(2)} km` : "—"],
    ["Avg resolution", `${snapshot.avg_resolution_ms.toFixed(0)} ms`],
    ["Nodes failed", `${snapshot.nodes_failed}`],
    ["Partitions", `${snapshot.partition_events}`],
    ["Sim time", `${snapshot.time.toFixed(1)} s`],
  ];

  return (
    <div className="panel dashboard">
      <h2>SKYMESH <span className="dot">●</span></h2>
      <div>
        {rows.map(([k, v]) => (
          <div key={k} style={metricStyle}>
            <span style={labelStyle}>{k}</span>
            <span style={valueStyle}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
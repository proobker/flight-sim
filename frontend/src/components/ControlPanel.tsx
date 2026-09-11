import { useState } from "react";

const btnStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "7px 10px",
  margin: "4px 0",
  background: "#1a2440",
  color: "#cfe0ff",
  border: "1px solid #2c3f66",
  borderRadius: "6px",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
};

const btnDanger: React.CSSProperties = { ...btnStyle, background: "#3a1222", borderColor: "#7a2430" };
const btnGo: React.CSSProperties = { ...btnStyle, background: "#123a1e", borderColor: "#2a6f3a" };

async function post(path: string, body?: unknown) {
  try {
    await fetch(`/api/control/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error("control failed", path, e);
  }
}

export function ControlPanel() {
  const [bleed, setBleed] = useState("");
  const [latency, setLatency] = useState("");
  const [traffic, setTraffic] = useState("10");

  return (
    <div className="panel controls">
      <h2>FAILURE INJECTION</h2>

      <h3>Node failures</h3>
      <button style={btnDanger} onClick={() => post("kill_random", { count: 5 })}>Kill 5 random aircraft</button>
      <button style={btnDanger} onClick={() => post("kill_random", { count: 20 })}>Kill 20 aircraft</button>
      <button style={btnGo} onClick={() => post("spawn_emergency")}>Spawn emergency aircraft</button>

      <h3>Network</h3>
      <button style={btnDanger} onClick={() => post("partition")}>Partition network</button>
      <button style={btnGo} onClick={() => post("rejoin")}>Rejoin network</button>

      <h3>Degradation</h3>
      <label style={{ color: "#8899bb", fontSize: 12 }}>
        Packet loss ({bleed || "0"}%)<br />
        <input
          type="range" min="0" max="100" value={bleed || "0"}
          onChange={(e) => setBleed(e.target.value)}
          onMouseUp={() => post("packet_loss", { value: Number(bleed) / 100 })}
          style={{ width: "100%" }}
        />
      </label>
      <label style={{ color: "#8899bb", fontSize: 12 }}>
        Latency ({latency || "0"} ms)<br />
        <input
          type="number" min="0" max="5000" value={latency}
          onChange={(e) => setLatency(e.target.value)}
          onBlur={() => post("latency", { ms: Number(latency) || 0 })}
          style={{ width: "100%", background: "#111a2e", color: "#cfe0ff", border: "1px solid #2c3f66", borderRadius: 4, padding: "4px" }}
        />
      </label>

      <h3>Airspace</h3>
      <button style={btnStyle} onClick={() => post("storm")}>Create storm</button>
      <button style={btnStyle} onClick={() => post("add_nofly")}>Add no-fly zone</button>
      <button style={btnStyle} onClick={() => post("close_airport")}>Close airport</button>
      <label style={{ color: "#8899bb", fontSize: 12 }}>
        Add aircraft ({traffic})<br />
        <input
          type="number" min="1" max="100" value={traffic}
          onChange={(e) => setTraffic(e.target.value)}
          onBlur={() => post("traffic", { count: Number(traffic) || 10 })}
          style={{ width: "100%", background: "#111a2e", color: "#cfe0ff", border: "1px solid #2c3f66", borderRadius: 4, padding: "4px" }}
        />
        <button style={{ ...btnGo, marginTop: 6 }} onClick={() => post("traffic", { count: Number(traffic) || 10 })}>
          Spawn
        </button>
      </label>
    </div>
  );
}
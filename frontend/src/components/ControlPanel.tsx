import { useState } from "react";

const btnBase: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 10px",
  margin: "3px 0",
  background: "#0c1a14",
  color: "#aabb99",
  border: "1px solid #1a3a2a",
  borderRadius: 3,
  cursor: "pointer",
  textAlign: "left",
  fontSize: 11,
  fontFamily: "'Consolas', 'Courier New', monospace",
  letterSpacing: "0.5px",
  transition: "all 0.15s ease",
};

const btnDanger: React.CSSProperties = {
  ...btnBase,
  background: "#1a0c0c",
  color: "#cc7766",
  borderColor: "#3a1a1a",
};

const btnGo: React.CSSProperties = {
  ...btnBase,
  background: "#0c1a14",
  color: "#66cc88",
  borderColor: "#1a3a2a",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#0c1218",
  color: "#aabb99",
  border: "1px solid #1a3a2a",
  borderRadius: 3,
  padding: "4px 6px",
  fontSize: 11,
  fontFamily: "'Consolas', 'Courier New', monospace",
  outline: "none",
};

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
      <button style={btnDanger} onClick={() => post("kill_random", { count: 5 })}>Kill 5 random</button>
      <button style={btnDanger} onClick={() => post("kill_random", { count: 20 })}>Kill 20 random</button>
      <button style={btnGo} onClick={() => post("spawn_emergency")}>Spawn emergency</button>

      <h3>Network</h3>
      <button style={btnDanger} onClick={() => post("partition")}>Partition network</button>
      <button style={btnGo} onClick={() => post("rejoin")}>Rejoin network</button>

      <h3>Degradation</h3>
      <label style={{ color: "#779966", fontSize: 11, fontFamily: "'Consolas', monospace" }}>
        Packet loss ({bleed || "0"}%)<br />
        <input
          type="range" min="0" max="100" value={bleed || "0"}
          onChange={(e) => setBleed(e.target.value)}
          onMouseUp={() => post("packet_loss", { value: Number(bleed) / 100 })}
          style={{ width: "100%", accentColor: "#33ff88" }}
        />
      </label>
      <label style={{ color: "#779966", fontSize: 11, fontFamily: "'Consolas', monospace" }}>
        Latency ({latency || "0"} ms)<br />
        <input
          type="number" min="0" max="5000" value={latency}
          onChange={(e) => setLatency(e.target.value)}
          onBlur={() => post("latency", { ms: Number(latency) || 0 })}
          style={inputStyle}
        />
      </label>

      <h3>Airspace</h3>
      <button style={btnBase} onClick={() => post("storm")}>Create storm</button>
      <button style={btnBase} onClick={() => post("add_nofly")}>Add no-fly zone</button>
      <button style={btnBase} onClick={() => post("close_airport")}>Close airport</button>
      <label style={{ color: "#779966", fontSize: 11, fontFamily: "'Consolas', monospace" }}>
        Add aircraft ({traffic})<br />
        <input
          type="number" min="1" max="100" value={traffic}
          onChange={(e) => setTraffic(e.target.value)}
          style={inputStyle}
        />
        <button
          style={{ ...btnGo, marginTop: 4 }}
          onClick={() => post("traffic", { count: Number(traffic) || 10 })}
        >
          Spawn
        </button>
      </label>
    </div>
  );
}

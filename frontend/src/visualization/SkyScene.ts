/**
 * SkyScene — Three.js 3D visualization of the SkyMesh airspace.
 *
 * Renders airplane markers, predicted trajectory vectors, conflict lines,
 * communication links, obstacles, uncertainty regions, destination markers,
 * avoidance waypoints, an infinite tiled ground, rolling terrain, airports,
 * sky dome, stars, sun, and a textured ground plane.
 * Supports day/night mode toggle and conflict-line visibility toggle.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SimSnapshot, AircraftSnapshot, Airport, TerrainMeta } from "../api/types";

const COMM_LINE_COLOR = 0x336688;
const STALE_LINE_COLOR = 0x995533;
const CONFLICT_COLOR = 0xff2222;
const WAYPOINT_COLOR = 0xffaa44;

// Per-flight-phase body colours — the plane's livery carries the phase.
const PHASE_COLORS: Record<string, number> = {
  parked: 0x8a8a8a,
  taxi_out: 0x9aa030,
  line_up: 0xc0c020,
  takeoff: 0x6fc050,
  climbout: 0x42b062,
  climb: 0x2aa890,
  cruise: 0x38b0f0,
  descent: 0xffa040,
  downwind: 0xff8840,
  base: 0xff6644,
  final: 0xff5540,
  flare: 0xee4433,
  rollout: 0x808080,
  taxi_in: 0x777788,
  go_around: 0xff5544,
};
const GROUND_PHASES = new Set([
  "parked", "taxi_out", "line_up", "takeoff", "rollout", "taxi_in",
]);

// Deterministic palette keyed to airport id (APT1..APT6).
const AIRPORT_COLORS = [0xe8593a, 0xe8a33a, 0x4ac95f, 0x3ac9c9, 0x4a7fe8, 0xb56ce8];

function airportColorById(id: string | null | undefined): number {
  const m = /(\d+)$/.exec(id ?? "");
  if (!m) return 0x8899aa;
  const i = parseInt(m[1], 10) - 1;
  return AIRPORT_COLORS[(i % AIRPORT_COLORS.length + AIRPORT_COLORS.length) % AIRPORT_COLORS.length];
}

function wrapAngleToPi(a: number): number {
  return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

const NIGHT_SKY = { top: 0x071030, mid: 0x1a3050, bottom: 0x0e1818 };
const DAY_SKY = { top: 0x2277cc, mid: 0x66bbee, bottom: 0xcceeff };
const NIGHT_CLEAR = 0x0a0a1a;
const DAY_CLEAR = 0x87ceeb;
const NIGHT_FOG_DENSITY = 0.000022;
const DAY_FOG_DENSITY = 0.000012;

// The ground extends far beyond the sky dome and fog so its edge is never
// visible — the world reads as endless.
const GROUND_HALF_EXTENT = 160000;
const GROUND_CLEARANCE = 80;

// Sim (x, y, z_alt) → Three (x, z_alt, y)
function toThree(pos: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(pos[0], pos[2], pos[1]);
}

// Deterministic PRNG so terrain is identical on every rebuild.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ────── shared airplane geometries (created once, rotated once) ──────

const FUSE_GEO = new THREE.CylinderGeometry(28, 42, 310, 14);
FUSE_GEO.rotateX(Math.PI / 2);
const NOSE_GEO = new THREE.ConeGeometry(28, 80, 14);
NOSE_GEO.rotateX(Math.PI / 2);
const WING_GEO = new THREE.BoxGeometry(380, 10, 60);
const TAIL_GEO = new THREE.BoxGeometry(150, 8, 30);
const FIN_GEO = new THREE.BoxGeometry(10, 85, 44);

function buildAirplane(color: number): {
  group: THREE.Group;
  mat: THREE.MeshPhongMaterial;
} {
  const mat = new THREE.MeshPhongMaterial({ color, shininess: 40 });
  const group = new THREE.Group();
  const fuse = new THREE.Mesh(FUSE_GEO, mat);
  fuse.position.z = -15;
  group.add(fuse);
  const nose = new THREE.Mesh(NOSE_GEO, mat);
  nose.position.z = 170;
  group.add(nose);
  const wings = new THREE.Mesh(WING_GEO, mat);
  wings.position.set(0, -6, 12);
  group.add(wings);
  const tailPlane = new THREE.Mesh(TAIL_GEO, mat);
  tailPlane.position.set(0, -2, -148);
  group.add(tailPlane);
  const fin = new THREE.Mesh(FIN_GEO, mat);
  fin.position.set(0, 48, -140);
  group.add(fin);
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return { group, mat };
}

// ────── canvas helpers ──────

function makeSunTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,240,1)");
  grad.addColorStop(0.3, "rgba(255,255,200,0.5)");
  grad.addColorStop(1, "rgba(255,255,200,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * A ground texture drawn as a torus (every patch is stamped at ±size offsets)
 * so it repeats seamlessly — required for the infinite ground plane.
 */
function makeGroundTexture(day: boolean): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = day ? "#4a8c3f" : "#0e1f14";
  ctx.fillRect(0, 0, size, size);

  const patchCount = day ? 60 : 50;
  for (let i = 0; i < patchCount; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const w = 20 + Math.random() * 70;
    const h = 20 + Math.random() * 70;
    ctx.globalAlpha = 0.15 + Math.random() * 0.25;
    if (day) {
      const g = 110 + Math.floor(Math.random() * 50);
      ctx.fillStyle = `rgb(${40 + Math.floor(Math.random() * 30)},${g},${30 + Math.floor(Math.random() * 20)})`;
    } else {
      ctx.fillStyle = `rgb(${10 + Math.floor(Math.random() * 18)},${22 + Math.floor(Math.random() * 22)},${8 + Math.floor(Math.random() * 14)})`;
    }
    for (const ox of [0, -size, size]) {
      for (const oy of [0, -size, size]) {
        ctx.fillRect(x + ox, y + oy, w, h);
      }
    }
  }
  ctx.globalAlpha = 1;

  const lineCount = day ? 6 : 4;
  ctx.strokeStyle = day ? "rgba(90,70,50,0.15)" : "rgba(55,75,45,0.25)";
  ctx.lineWidth = 1;
  for (let i = 0; i < lineCount; i++) {
    const x1 = Math.random() * size;
    const x2 = Math.random() * size;
    const y1 = Math.random() * size;
    const y2 = Math.random() * size;
    for (const ox of [0, -size, size]) {
      for (const oy of [0, -size, size]) {
        ctx.beginPath();
        ctx.moveTo(x1 + ox, oy);
        ctx.lineTo(x2 + ox, size + oy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ox, y1 + oy);
        ctx.lineTo(size + ox, y2 + oy);
        ctx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeTextSprite(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 26px monospace";
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.textAlign = "center";
  ctx.fillText(text, 128, 52);
  const tex = new THREE.CanvasTexture(canvas);
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
}

// ────── prebuilt aircraft model (optional; procedural fallback) ──────

let sharedGlb: THREE.Group | null = null;
let glbLoading: Promise<THREE.Group | null> | null = null;

/**
 * Load `models/Aircraft.glb` once. The asset is generated by
 * `scripts/generate_aircraft_glb.mjs` with a documented convention:
 * nose → +Z and wings along ±X, so `rotation.y = heading` already orients it
 * nose-first with no bbox guessing. If the file is missing, aircraft fall
 * back to the procedural buildAirplane.
 */
function loadGlbModel(): Promise<THREE.Group | null> {
  if (glbLoading) return glbLoading;
  glbLoading = new Promise<THREE.Group | null>((resolve) => {
    try {
      new GLTFLoader().load(
        "models/Aircraft.glb",
        (gltf) => {
          try {
            const root = gltf.scene;
            root.traverse((o) => {
              if (o instanceof THREE.Mesh) {
                o.castShadow = true;
                o.frustumCulled = true;
              }
            });
            sharedGlb = root;
            resolve(root);
          } catch {
            resolve(null);
          }
        },
        undefined,
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
  return glbLoading;
}

// A material whose colour we can flip between day / night / closed.
interface ThemedMat {
  mat: THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.SpriteMaterial;
  day: number;
  night: number;
  closed?: number;
}

// ────── per-aircraft visual ──────

class AircraftVisual {
  group: THREE.Group;
  airplane: THREE.Group;
  airplaneMat: THREE.MeshPhongMaterial | null = null;
  usesGlb = false;
  velocityLine: THREE.Line;
  destinationLine: THREE.Line;
  waypointLine: THREE.Line;
  trailPoints: THREE.Vector3[] = [];
  trailLine: THREE.Line;
  label: THREE.Sprite;

  private originColor: THREE.Color;
  private destColor: THREE.Color;
  private smoothHeading: number | null = null;
  private bankAngle = 0;
  private labelCtx: CanvasRenderingContext2D;
  private labelMap: THREE.CanvasTexture;
  private labelKey = "";

  constructor(originColor: number, destColor: number) {
    this.group = new THREE.Group();
    this.originColor = new THREE.Color(originColor);
    this.destColor = new THREE.Color(destColor);
    const procedural = buildAirplane(originColor);
    if (sharedGlb) {
      this.airplane = sharedGlb.clone(true);
      this.usesGlb = true;
      // Clones share material instances; give each plane its own so the
      // per-aircraft phase tint doesn't recolor every other plane.
      this.airplane.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material) {
          o.material = o.material.clone();
        }
      });
    } else {
      this.airplane = procedural.group;
      this.airplaneMat = procedural.mat;
    }
    this.group.add(this.airplane);

    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 256;
    labelCanvas.height = 170;
    this.labelCtx = labelCanvas.getContext("2d")!;
    this.labelMap = new THREE.CanvasTexture(labelCanvas);
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.labelMap, transparent: true, depthTest: false }),
    );
    this.label.scale.set(520, 345, 1);
    this.label.position.set(0, 320, 0);
    this.label.visible = false;
    this.group.add(this.label);

    this.velocityLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 200, gapSize: 150, opacity: 0.5, transparent: true }),
    );
    this.group.add(this.velocityLine);

    this.destinationLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.12, transparent: true }),
    );
    this.group.add(this.destinationLine);

    this.waypointLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: WAYPOINT_COLOR, dashSize: 120, gapSize: 80, opacity: 0.55, transparent: true }),
    );
    this.group.add(this.waypointLine);

    this.trailLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.25, transparent: true }),
    );
    this.group.add(this.trailLine);
  }

  update(ac: AircraftSnapshot) {
    const pos = toThree(ac.position);
    this.group.position.copy(pos);

    // Heading smooths towards the true bearing and the plane banks into the
    // turn, so the body always leads the motion nose-first (never tail/sideways).
    if (this.smoothHeading === null) this.smoothHeading = ac.heading;
    const rawDelta = wrapAngleToPi(ac.heading - this.smoothHeading);
    this.smoothHeading = wrapAngleToPi(this.smoothHeading + rawDelta * 0.35);
    const bankTarget = THREE.MathUtils.clamp(-rawDelta * 0.55, -0.55, 0.55);
    this.bankAngle += (bankTarget - this.bankAngle) * 0.18;
    const pitch = THREE.MathUtils.clamp(-ac.vertical_rate * 0.004, -0.22, 0.22);
    this.airplane.rotation.set(pitch, this.smoothHeading, this.bankAngle);

    // Body colour is phase-driven: the phase livery replaces the route
    // gradient, with a ground/emergency emissive so parked/rolling traffic
    // reads at a glance.
    const phaseColor = PHASE_COLORS[ac.phase];
    const livery = phaseColor
      ? phaseColor
      : this.originColor.clone().lerp(this.destColor, clamp01(ac.progress)).getHex();
    const glow = ac.emergency ? 0xff2222 : (phaseColor ?? 0x000000);
    const glowIntensity = ac.emergency ? 0.9 : phaseColor ? (GROUND_PHASES.has(ac.phase) ? 0.3 : 0.45) : 0.0;
    if (this.airplaneMat) {
      this.airplaneMat.color.setHex(livery);
      this.airplaneMat.emissive.setHex(glow);
      this.airplaneMat.emissiveIntensity = glowIntensity;
    } else if (this.usesGlb) {
      this.airplane.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const m = (o.material as unknown) as { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number };
        if (m.color) m.color.setHex(livery);
        if (m.emissive) m.emissive.setHex(glow);
        if (m.emissiveIntensity !== undefined) m.emissiveIntensity = glowIntensity;
      });
    }

    // Tag: aircraft id on top, flight phase beneath; a red banner appears while
    // the terrain look-ahead is warning. Redrawn only when the key changes.
    const tagKey = `${ac.id}|${ac.phase}|${ac.terrain_warning ? "TW" : ""}|${ac.agl | 0}`;
    if (tagKey !== this.labelKey) {
      this.labelKey = tagKey;
      const ctx = this.labelCtx;
      ctx.clearRect(0, 0, 256, 170);
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 32px monospace";
      ctx.fillText(ac.id, 128, 40);
      ctx.fillStyle = "#aaddff";
      ctx.font = "bold 22px monospace";
      ctx.fillText(ac.phase.toUpperCase(), 128, 104);
      ctx.fillStyle = phaseColor ? `#${phaseColor.toString(16).padStart(6, "0")}` : "#779966";
      ctx.fillRect(88, 132, 80, 8);
      if (ac.terrain_warning) {
        ctx.fillStyle = "#ff2211";
        ctx.fillRect(10, 118, 236, 26);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 17px monospace";
        ctx.fillText("TERRAIN AHEAD", 128, 137);
      } else {
        ctx.fillStyle = "#556644";
        ctx.font = "13px monospace";
        ctx.fillText(`AGL ${ac.agl.toFixed(0)}m`, 128, 150);
      }
      this.labelMap.needsUpdate = true;
    }

    const v = ac.velocity;
    const speed = Math.hypot(v[0], v[1]);
    if (speed > 1) {
      const dir = new THREE.Vector3(v[0], v[2], v[1]).normalize();
      const predictDist = Math.min(speed * 15, 2500);
      this.velocityLine.geometry.dispose();
      this.velocityLine.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        dir.multiplyScalar(predictDist),
      ]);
      this.velocityLine.computeLineDistances();
      this.velocityLine.visible = true;
    } else {
      this.velocityLine.visible = false;
    }

    const dest = toThree(ac.destination);
    const destLocal = dest.clone().sub(pos);
    if (destLocal.length() > 100) {
      this.destinationLine.geometry.dispose();
      this.destinationLine.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        destLocal,
      ]);
      this.destinationLine.visible = true;
    } else {
      this.destinationLine.visible = false;
    }

    if (ac.waypoint) {
      const wp = toThree(ac.waypoint);
      const wpLocal = wp.clone().sub(pos);
      if (wpLocal.length() > 50) {
        this.waypointLine.geometry.dispose();
        this.waypointLine.geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          wpLocal,
        ]);
        this.waypointLine.computeLineDistances();
        this.waypointLine.visible = true;
      } else {
        this.waypointLine.visible = false;
      }
    } else {
      this.waypointLine.visible = false;
    }

    if (ac.state !== "held") {
      this.trailPoints.push(pos.clone());
      if (this.trailPoints.length > 30) this.trailPoints.shift();
      if (this.trailPoints.length > 1) {
        const local = this.trailPoints.map((p) => p.clone().sub(pos));
        this.trailLine.geometry.dispose();
        this.trailLine.geometry = new THREE.BufferGeometry().setFromPoints(local);
      }
    }
  }

  dispose() {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this.label.material.dispose();
    this.labelMap.dispose();
  }
}

// ────── SkyScene ──────

export interface ViewOptions {
  dayMode: boolean;
  showConflicts: boolean;
  showTags: boolean;
}

export class SkyScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  container: HTMLElement;

  aircraftMap: Map<string, AircraftVisual> = new Map();
  conflictLines: THREE.Line[] = [];
  neighborLines: THREE.Line[] = [];
  obstacleGroups: Map<string, THREE.Group> = new Map();
  uncertainMeshes: Map<string, THREE.Mesh> = new Map();

  sunLight: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;

  // Auto-framed once the first snapshot delivers real airspace dimensions.
  private framedToContent = false;

  boundsGroup: THREE.Group;
  skyMesh: THREE.Mesh | null = null;
  skyStarField: THREE.Points | null = null;
  skySun: THREE.Sprite | null = null;
  groundMesh: THREE.Mesh | null = null;
  terrainGroup: THREE.Group | null = null;

  private terrainMat: THREE.MeshLambertMaterial | null = null;
  private heightAt: (sx: number, sy: number) => number = () => 0;
  private terrainGrid: Float32Array | null = null;
  private terrainMeta: TerrainMeta | null = null;
  private airportGroups: Map<string, THREE.Group> = new Map();
  private airportThemes: Map<string, ThemedMat[]> = new Map();
  private terrainThemes: ThemedMat[] = [];

  private lastSnapshot: SimSnapshot | null = null;

  viewOptions: ViewOptions = { dayMode: false, showConflicts: true, showTags: true };

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(NIGHT_CLEAR);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(NIGHT_CLEAR, NIGHT_FOG_DENSITY);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 50, 120000);
    this.camera.position.set(6000, 9000, 18000);
    this.camera.lookAt(7500, 1500, 7500);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(7500, 1500, 7500);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 1000;
    this.controls.maxDistance = 200000;

    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambient);
    const dir = new THREE.DirectionalLight(0xfff8e8, 0.85);
    dir.position.set(10000, 18000, 5000);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1000;
    dir.shadow.camera.far = 30000;
    dir.shadow.camera.left = -2200;
    dir.shadow.camera.right = 2200;
    dir.shadow.camera.top = 2200;
    dir.shadow.camera.bottom = -2200;
    dir.shadow.bias = -0.0006;
    this.scene.add(dir);
    this.scene.add(dir.target);
    this.sunLight = dir;
    this.hemi = new THREE.HemisphereLight(0x8888ff, 0x443322, 0.3);
    this.scene.add(this.hemi);

    this.boundsGroup = new THREE.Group();
    this.scene.add(this.boundsGroup);

    window.addEventListener("resize", this.onResize);
    loadGlbModel();
    this.loadTerrain();
    this.animate();
  }

  /** Fetch the authoritative elevation grid from the backend, then sculpt the terrain. */
  async loadTerrain() {
    try {
      const metaRes = await fetch("/api/terrain", { headers: { Accept: "application/json" } });
      if (!metaRes.ok) {
        console.warn(`[terrain] metadata request failed (${metaRes.status})`);
        return;
      }
      const meta = (await metaRes.json()) as TerrainMeta & { enabled?: boolean };
      if (!meta.enabled || !meta.width || !meta.height) {
        console.warn("[terrain] disabled in backend — rendering flat");
        return;
      }
      const gridRes = await fetch("/api/terrain/grid");
      if (!gridRes.ok) {
        console.warn(`[terrain] grid request failed (${gridRes.status})`);
        return;
      }
      const buf = await gridRes.arrayBuffer();
      const cells = meta.width * meta.height;
      const f32 = cells * 4;
      const f64 = cells * 8;
      if (buf.byteLength !== f32 && buf.byteLength !== f64) {
        console.warn(`[terrain] grid size mismatch (${buf.byteLength}B, expected ${f32}B or ${f64}B) — staying flat`);
        return;
      }
      this.terrainMeta = meta;
      // float32 (864 KB-ish) is the backend contract; tolerate float64 so a
      // future dtype slip can never blank the landscape silently again.
      this.terrainGrid = buf.byteLength === f64 ? new Float32Array(new Float64Array(buf)) : new Float32Array(buf);
      // Bilinear lookup over the backend grid (row = y, col = x).
      this.heightAt = (sx: number, sy: number) => {
        const { x0, y0, cell, width } = meta;
        const fx = (sx - x0) / cell;
        const fy = (sy - y0) / cell;
        const xi = Math.max(0, Math.min(meta.width - 2, Math.floor(fx)));
        const yi = Math.max(0, Math.min(meta.height - 2, Math.floor(fy)));
        const tx = fx - xi;
        const ty = fy - yi;
        const g = this.terrainGrid!;
        const a = g[yi * width + xi];
        const b = g[yi * width + xi + 1];
        const c = g[(yi + 1) * width + xi];
        const d = g[(yi + 1) * width + xi + 1];
        return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
      };
      this.rebuildTerrain();
      // Airports built on the flat baseline (before the grid was ready) now
      // float up onto their flattened field elevations.
      this.repositionAirportsToTerrain();
    } catch {
      // Backend without terrain: stay flat and consistent with the backend.
    }
  }

  setOptions(opts: Partial<ViewOptions>) {
    const prev = { ...this.viewOptions };
    if (opts.dayMode !== undefined) this.viewOptions.dayMode = opts.dayMode;
    if (opts.showConflicts !== undefined) this.viewOptions.showConflicts = opts.showConflicts;
    if (opts.showTags !== undefined) this.viewOptions.showTags = opts.showTags;

    if (prev.dayMode !== this.viewOptions.dayMode) {
      this.rebuildEnvironment();
    }

    if (prev.showTags !== this.viewOptions.showTags) {
      for (const vis of this.aircraftMap.values()) {
        vis.label.visible = this.viewOptions.showTags;
      }
    }

    if (prev.showConflicts !== this.viewOptions.showConflicts) {
      if (!this.viewOptions.showConflicts) {
        this.conflictLines.forEach((l) => this.scene.remove(l));
        this.conflictLines = [];
      } else if (this.lastSnapshot) {
        this.updateConflicts(this.lastSnapshot.aircraft);
      }
    }
  }

  resetView() {
    const air = this.lastSnapshot?.airspace;
    if (air) {
      const cx = air.width / 2;
      const cz = air.depth / 2;
      this.camera.position.set(cx + 40000, 28000, cz + 86000);
      this.controls.target.set(cx, 600, cz);
    } else {
      this.camera.position.set(6000, 9000, 18000);
      this.controls.target.set(7500, 1500, 7500);
    }
    this.controls.update();
  }

  private rebuildEnvironment() {
    const day = this.viewOptions.dayMode;
    const clearColor = day ? DAY_CLEAR : NIGHT_CLEAR;

    this.renderer.setClearColor(clearColor);
    (this.scene.fog as THREE.FogExp2).color.setHex(clearColor);
    (this.scene.fog as THREE.FogExp2).density = day ? DAY_FOG_DENSITY : NIGHT_FOG_DENSITY;

    // Scene lighting: daytime sun keeps the full day values; at night the sun
    // falls behind a dim blue moon and the fills fade so the world goes dark
    // and the glowing beacons / tags carry the scene.
    this.sunLight.intensity = day ? 0.85 : 0.16;
    this.sunLight.color.setHex(day ? 0xfff8e8 : 0x9fb4dd);
    this.ambient.intensity = day ? 0.35 : 0.10;
    this.ambient.color.setHex(day ? 0xffffff : 0x2a3550);
    this.hemi.intensity = day ? 0.3 : 0.12;
    this.hemi.color.setHex(day ? 0x8888ff : 0x223355);
    this.hemi.groundColor.setHex(day ? 0x443322 : 0x0a0c12);

    this.rebuildBounds();
    this.rebuildSky();
    this.rebuildGround();
    this.applyTerrainTheme(day);
    this.applyAirportTheme(day);
  }

  private rebuildSky() {
    if (this.skyMesh) {
      this.scene.remove(this.skyMesh);
      (this.skyMesh.material as THREE.ShaderMaterial).dispose();
      this.skyMesh.geometry.dispose();
      this.skyMesh = null;
    }
    if (this.skyStarField) {
      this.scene.remove(this.skyStarField);
      this.skyStarField.geometry.dispose();
      (this.skyStarField.material as THREE.Material).dispose();
      this.skyStarField = null;
    }
    if (this.skySun) {
      this.scene.remove(this.skySun);
      (this.skySun.material as THREE.Material).dispose();
      this.skySun = null;
    }

    const day = this.viewOptions.dayMode;
    const colors = day ? DAY_SKY : NIGHT_SKY;

    const air = this.lastSnapshot?.airspace ?? { width: 15000, depth: 15000, ceiling: 5000 };
    const w = air.width;
    const d = air.depth;
    const ceiling = air.ceiling;
    const radius = 55000;

    const geo = new THREE.SphereGeometry(radius, 28, 18);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(colors.top) },
        midColor: { value: new THREE.Color(colors.mid) },
        bottomColor: { value: new THREE.Color(colors.bottom) },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor, midColor, bottomColor;
        varying vec3 vWorldPos;
        void main() {
          float h = normalize(vWorldPos).y;
          vec3 c = h > 0.0
            ? mix(midColor, topColor, clamp(h, 0.0, 1.0))
            : mix(midColor, bottomColor, clamp(-h, 0.0, 1.0));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.position.set(w / 2, ceiling / 2, d / 2);
    this.scene.add(sky);
    this.skyMesh = sky;

    if (!day) {
      const verts: number[] = [];
      for (let i = 0; i < 500; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 0.85 + 0.15);
        const r = radius * 0.95;
        verts.push(
          r * Math.sin(phi) * Math.cos(theta) + w / 2,
          r * Math.cos(phi) + ceiling / 2,
          r * Math.sin(phi) * Math.sin(theta) + d / 2,
        );
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      const stars = new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({ color: 0xaabbee, size: 45, sizeAttenuation: true, fog: false }),
      );
      this.scene.add(stars);
      this.skyStarField = stars;
    }

    const sun = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeSunTexture(),
        color: day ? 0xffffff : 0xffffee,
        fog: false,
        transparent: true,
        opacity: day ? 1.0 : 0.85,
      }),
    );
    sun.position.set(w * 1.5, ceiling * 3, d * 0.5);
    const sunScale = day ? 8000 : 6000;
    sun.scale.set(sunScale, sunScale, 1);
    this.scene.add(sun);
    this.skySun = sun;
  }

  private rebuildGround() {
    if (this.groundMesh) {
      this.scene.remove(this.groundMesh);
      (this.groundMesh.material as THREE.MeshLambertMaterial).map?.dispose();
      (this.groundMesh.material as THREE.Material).dispose();
      this.groundMesh.geometry.dispose();
      this.groundMesh = null;
    }

    const day = this.viewOptions.dayMode;
    const width = this.lastSnapshot?.airspace.width ?? 15000;
    const depth = this.lastSnapshot?.airspace.depth ?? 15000;
    const floor = this.lastSnapshot?.airspace.floor ?? 100;

    const size = GROUND_HALF_EXTENT * 2;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const tex = makeGroundTexture(day);
    const tileMetres = 900;
    tex.repeat.set(size / tileMetres, size / tileMetres);
    const mat = new THREE.MeshLambertMaterial({
      map: tex,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(width / 2, floor - GROUND_CLEARANCE, depth / 2);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.groundMesh = mesh;
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    // Keep the shadow-casting sun pinned to the viewer so shadows are crisp
    // wherever the camera is instead of spanning the whole sim.
    const sunDir = this.viewOptions.dayMode
      ? new THREE.Vector3(0.55, 0.9, 0.25)
      : new THREE.Vector3(-0.7, 0.4, -0.3);
    this.sunLight.position.copy(this.camera.position).addScaledVector(sunDir, 6000);
    this.sunLight.target.position.copy(this.camera.position);
    this.sunLight.target.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
  };

  private onResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  update(snapshot: SimSnapshot) {
    this.lastSnapshot = snapshot;
    const { width, depth, floor, ceiling } = snapshot.airspace;
    this.updateBounds(width, depth, floor, ceiling);
    this.frameContent(width, depth);
    this.updateSkyIfNeeded();
    this.updateGroundIfNeeded();
    this.ensureTerrain();
    this.updateAirports(snapshot.airspace.airports);
    this.repositionAirportsToTerrain();
    this.updateObstacles(snapshot.airspace.obstacles);
    this.updateAircraft(snapshot.aircraft);
    this.updateConflicts(snapshot.aircraft);
    this.updateNeighborLines(snapshot.aircraft);
    this.updateUncertainty(snapshot);
  }

  /**
   * Put the camera over the airspace the first time dimensions are known, so
   * the user lands on the airports/terrain instead of the empty origin corner.
   */
  private frameContent(width: number, depth: number) {
    if (this.framedToContent) return;
    this.framedToContent = true;
    const cx = width / 2;
    const cz = depth / 2;
    this.camera.position.set(cx + 40000, 28000, cz + 86000);
    this.controls.target.set(cx, 600, cz);
    this.controls.update();
  }

  private updateBounds(width: number, depth: number, floor: number, _ceiling: number) {
    if (this.boundsGroup.userData.boundsBuilt) return;
    this.boundsGroup.userData.boundsBuilt = true;
    const day = this.viewOptions.dayMode;
    const gridColor1 = day ? 0x88aaaa : 0x222244;
    const gridColor2 = day ? 0x667777 : 0x111133;
    const grid = new THREE.GridHelper(GROUND_HALF_EXTENT * 2, 640, gridColor1, gridColor2);
    grid.position.set(width / 2, floor, depth / 2);
    const gridMat = grid.material as THREE.LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = day ? 0.12 : 0.2;
    this.boundsGroup.add(grid);
  }

  private rebuildBounds() {
    for (const child of [...this.boundsGroup.children]) {
      if (child instanceof THREE.LineSegments || child instanceof THREE.GridHelper) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      this.boundsGroup.remove(child);
    }
    this.boundsGroup.userData.boundsBuilt = false;
    const air = this.lastSnapshot?.airspace;
    if (air) {
      this.updateBounds(air.width, air.depth, air.floor, air.ceiling);
    }
  }

  private updateSkyIfNeeded() {
    if (!this.skyMesh) {
      this.rebuildSky();
    }
  }

  private updateGroundIfNeeded() {
    if (!this.groundMesh) {
      this.rebuildGround();
    }
  }

  // ────── airports ──────

  /**
   * Surface an airport sits on: the backend-flattened field elevation,
   * never sinking below the airport's own altitude (center[2]) no matter the
   * flatten tolerance or grid timing.
   */
  private airportGroundY(apt: Airport): number {
    const air = this.lastSnapshot!.airspace;
    const baseY = air.floor - GROUND_CLEARANCE;
    return baseY + Math.max(this.heightAt(apt.center[0], apt.center[1]), apt.center[2]);
  }

  /** Keep every airport group on the terrain surface. Early-outs when flush. */
  private repositionAirportsToTerrain() {
    const air = this.lastSnapshot?.airspace;
    if (!air) return;
    for (const apt of air.airports) {
      const group = this.airportGroups.get(apt.id);
      if (!group) continue;
      const newY = this.airportGroundY(apt);
      const oldY = (group.userData.groundY as number) ?? newY;
      const dy = newY - oldY;
      if (Math.abs(dy) < 0.5) continue;
      group.traverse((o) => {
        if (o !== group) o.position.y += dy;
      });
      group.userData.groundY = newY;
    }
  }

  private updateAirports(airports: Airport[]) {
    const incoming = new Set(airports.map((a) => a.id));
    for (const apt of airports) {
      const existing = this.airportGroups.get(apt.id);
      if (existing && existing.userData.closed === apt.closed) continue;
      if (existing) this.disposeAirport(apt.id);
      this.buildAirport(apt);
    }
    for (const id of [...this.airportGroups.keys()]) {
      if (!incoming.has(id)) this.disposeAirport(id);
    }
    this.applyAirportTheme(this.viewOptions.dayMode);
  }

  private buildAirport(apt: Airport) {
    // Sit on the backend-flattened field, always above the surface (see
    // airportGroundY). Falls back to the flat baseline until the grid loads.
    const groundY = this.airportGroundY(apt);
    const group = new THREE.Group();
    group.userData.groundY = groundY;
    const themes: ThemedMat[] = [];
    const px = apt.center[0];
    const pz = apt.center[1];

    const padMat = new THREE.MeshPhongMaterial({ opacity: 0.85, transparent: true });
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(apt.radius * 0.62, apt.radius * 0.62, 26, 28), padMat);
    pad.position.set(px, groundY + 13, pz);
    pad.receiveShadow = true;
    pad.castShadow = true;
    group.add(pad);
    themes.push({ mat: padMat, day: 0x595961, night: 0x1a2026, closed: 0x5a2f2b });

    if (apt.hub) {
      const hubMat = new THREE.MeshPhongMaterial({ opacity: 0.5, transparent: true });
      const apron = new THREE.Mesh(
        new THREE.RingGeometry(apt.radius * 1.05, apt.radius * 1.2, 48),
        hubMat,
      );
      apron.rotation.x = -Math.PI / 2;
      apron.position.set(px, groundY + 18, pz);
      group.add(apron);
      themes.push({ mat: hubMat, day: 0x55555f, night: 0x20242a, closed: 0x4a2f2c });
    }

    // Real runways from the backend snapshot: asphalt strip + white centerline,
    // aligned to each runway's inbound heading (sim → three: +y → +z).
    for (const r of apt.runways) {
      const ux = Math.sin(r.heading);
      const uy = Math.cos(r.heading);
      const cx = r.threshold[0] - ux * (r.length / 2);
      const cz = r.threshold[1] - uy * (r.length / 2);
      const rotY = r.heading - Math.PI / 2;

      const stripMat = new THREE.MeshPhongMaterial({ opacity: 0.92, transparent: true });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(r.length, 8, 50), stripMat);
      strip.position.set(cx, groundY + 7, cz);
      strip.rotation.y = rotY;
      strip.receiveShadow = true;
      group.add(strip);
      themes.push({ mat: stripMat, day: 0x3a3d42, night: 0x14161a, closed: 0x4a2f2c });

      const lineMat = new THREE.MeshPhongMaterial({ opacity: 0.95, transparent: true });
      const line = new THREE.Mesh(new THREE.BoxGeometry(r.length, 10, 6), lineMat);
      line.position.set(cx, groundY + 9, cz);
      line.rotation.y = rotY;
      group.add(line);
      themes.push({ mat: lineMat, day: 0xe8e8e8, night: 0x99a4b3, closed: 0xbb7777 });
    }

    const termMat = new THREE.MeshPhongMaterial();
    const term = new THREE.Mesh(new THREE.BoxGeometry(140, 60, 80), termMat);
    term.position.set(px + apt.radius * 0.62 * 0.55, groundY + 30, pz);
    term.castShadow = true;
    term.receiveShadow = true;
    group.add(term);
    themes.push({ mat: termMat, day: 0x9aa0a6, night: 0x22262c, closed: 0x74423b });

    const roofMat = new THREE.MeshPhongMaterial();
    const roof = new THREE.Mesh(new THREE.BoxGeometry(150, 12, 92), roofMat);
    roof.position.set(px + apt.radius * 0.62 * 0.55, groundY + 62, pz);
    roof.castShadow = true;
    group.add(roof);
    themes.push({ mat: roofMat, day: 0x61666b, night: 0x14171c, closed: 0x552e28 });

    // Airport identity beacon: a lit ring around the pad and a small cone so
    // each field reads instantly in its own colour (matches plane gradients).
    const beaconColor = airportColorById(apt.id);
    const ringMat = new THREE.MeshPhongMaterial({
      color: beaconColor,
      emissive: beaconColor,
      emissiveIntensity: 0.45,
      opacity: 0.3,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(apt.radius * 0.74, apt.radius * 0.82, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(px, groundY + 36, pz);
    group.add(ring);
    themes.push({ mat: ringMat, day: beaconColor, night: beaconColor, closed: 0x3a3a3a });

    const beaconMat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: beaconColor,
      emissiveIntensity: 0.8,
    });
    const beacon = new THREE.Mesh(new THREE.ConeGeometry(16, 40, 8), beaconMat);
    beacon.position.set(px + apt.radius * 0.62 * 0.55, groundY + 92, pz);
    group.add(beacon);
    themes.push({ mat: beaconMat, day: 0xffffff, night: 0xffffff, closed: 0x666666 });

    const label = makeTextSprite(
      apt.closed ? "CLOSED" : apt.hub ? `${apt.name} · HUB` : apt.name,
      0xffffff,
    );
    label.position.set(px, groundY + 110, pz);
    label.scale.set(430, 180, 1);
    group.add(label);
    themes.push({ mat: label.material, day: 0x143014, night: 0xddf5dd, closed: 0xff4433 });

    group.userData.closed = apt.closed;
    this.scene.add(group);
    this.airportGroups.set(apt.id, group);
    this.airportThemes.set(apt.id, themes);
  }

  private disposeAirport(id: string) {
    const group = this.airportGroups.get(id);
    if (group) {
      this.scene.remove(group);
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
        if (child instanceof THREE.Sprite) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    }
    this.airportGroups.delete(id);
    this.airportThemes.delete(id);
  }

  private applyAirportTheme(day: boolean) {
    for (const [id, themes] of this.airportThemes) {
      const closed = this.airportGroups.get(id)?.userData.closed === true;
      for (const t of themes) {
        t.mat.color.setHex(closed && t.closed !== undefined ? t.closed : day ? t.day : t.night);
      }
    }
  }

// ────── terrain (hard elevation from the backend grid) ──────

  private ensureTerrain() {
    if (this.terrainGroup) return;
    const group = new THREE.Group();
    this.terrainGroup = group;
    this.scene.add(group);
    this.buildTerrain(group);
  }

  /** Rebuild when the authoritative elevation grid arrives from the backend. */
  private rebuildTerrain() {
    if (this.terrainGroup) {
      this.scene.remove(this.terrainGroup);
      this.terrainGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const m = child.material as THREE.Material & { map?: THREE.Texture | null };
          if (m.map) m.map.dispose();
          m.dispose();
        }
      });
      this.terrainThemes = [];
    }
    this.terrainGroup = null;
    if (this.lastSnapshot) this.ensureTerrain();
  }

  private buildTerrain(group: THREE.Group) {
    const air = this.lastSnapshot!.airspace;
    const meta = this.terrainMeta;
    const hasGrid = !!meta && !!this.terrainGrid;

    // Full extent of the authoritative elevation grid (or a small flat
    // fallback when the backend has no terrain).
    const regionHalf = hasGrid ? Math.round((meta!.height - 1) * meta!.cell / 2) : 15000;
    const zmin = meta ? meta.zmin : air.floor;
    const zmax = meta ? meta.zmax : air.floor + 120;
    const baseY = air.floor - GROUND_CLEARANCE;
    const areaCX = air.width / 2;
    const areaCZ = air.depth / 2;
    const rnd = mulberry32(1337);

    const airports = air.airports.map((a) => ({
      lx: a.center[0] - areaCX,
      lz: a.center[1] - areaCZ,
      r: a.radius,
    }));

    // ── heightfield mesh (dense near the sim centre, coarse at the rim) ──
    const N = 430;
    const cols = N + 1;
    const vertexCount = cols * cols;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const indices: number[] = [];

    const compression = 3.1;
    const tanhC = Math.tanh(compression);
    const mapU = (u: number) => Math.tanh((u - 0.5) * 2 * compression) / tanhC;
    const rockLine = zmin + 0.5 * (zmax - zmin);
    const rockSpan = Math.max(1, zmax - rockLine);
    const low = { r: 0.30, g: 0.58, b: 0.22 };
    const high = { r: 0.62, g: 0.58, b: 0.55 };

    for (let r = 0; r < cols; r++) {
      for (let c = 0; c < cols; c++) {
        const lx = mapU(c / N) * regionHalf;
        const ly = mapU(r / N) * regionHalf;
        const sx = areaCX + lx;
        const sy = areaCZ + ly;
        const hgt = this.heightAt(sx, sy);
        const i = r * cols + c;
        positions[i * 3 + 0] = sx;
        positions[i * 3 + 1] = baseY + hgt;
        positions[i * 3 + 2] = sy;

        // Vertex tint: green lowlands rise through tawny foothills to pale
        // rocky crests; a faint puckering keeps broad faces from looking flat.
        const crest = clamp01((hgt - rockLine) / rockSpan);
        const vib = 0.05 * Math.sin(sx * 0.0017 + sy * 0.0009 + hgt * 0.002);
        colors[i * 3 + 0] = low.r + (high.r - low.r) * crest + vib;
        colors[i * 3 + 1] = low.g + (high.g - low.g) * crest + vib;
        colors[i * 3 + 2] = low.b + (high.b - low.b) * crest + vib;
      }
    }
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const a = r * cols + c;
        const b = a + cols;
        indices.push(a, b, a + 1);
        indices.push(a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const heightfield = new THREE.Mesh(geo, mat);
    heightfield.castShadow = false;
    heightfield.receiveShadow = true;
    group.add(heightfield);
    this.terrainMat = mat;

    const clearOf = (x: number, z: number, r: number) =>
      airports.every((a) => Math.hypot(x - areaCX - a.lx, z - areaCZ - a.lz) > r);

    const scatter = (half: number, minClear: number): [number, number] | null => {
      for (let tries = 0; tries < 12; tries++) {
        const x = areaCX + (rnd() * 2 - 1) * half;
        const z = areaCZ + (rnd() * 2 - 1) * half;
        if (clearOf(x, z, minClear)) return [x, z];
      }
      return null;
    };

    const themed = (mat: THREE.MeshLambertMaterial, day: number, night: number) => {
      this.terrainThemes.push({ mat, day, night });
      return mat;
    };

    // A surface patch sits *on* the elevation model only in low, gentle
    // country so trees and rocks never float on mountain slopes.
    const flatSpot = (x: number, z: number): boolean => {
      const h = this.heightAt(x, z);
      return Math.abs(h - this.heightAt(x + 600, z)) < 40 && Math.abs(h - this.heightAt(x, z + 600)) < 40;
    };

    // trees in small clusters, snapped onto the terrain surface
    const treeMat = themed(new THREE.MeshLambertMaterial(), 0x2f6b2f, 0x0e2416);
    const trunkMat = themed(new THREE.MeshLambertMaterial(), 0x6b5233, 0x241a0e);
    const treeGeo = new THREE.ConeGeometry(1, 1, 5);
    const trunkGeo = new THREE.CylinderGeometry(1, 1, 1, 5);
    for (let i = 0; i < 30; i++) {
      const spot = scatter(Math.min(regionHalf * 0.45, 9000), 1700);
      if (!spot) continue;
      if (!flatSpot(spot[0], spot[1])) continue;
      const n = 3 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) {
        const ox = spot[0] + (rnd() * 2 - 1) * 260;
        const oz = spot[1] + (rnd() * 2 - 1) * 260;
        if (!clearOf(ox, oz, 1300) || !flatSpot(ox, oz)) continue;
        const h = 34 + rnd() * 26;
        const tw = h * (0.45 + rnd() * 0.2);
        const groundY = baseY + this.heightAt(ox, oz);
        const tree = new THREE.Mesh(treeGeo, treeMat);
        tree.scale.set(tw, h, tw);
        tree.position.set(ox, groundY + h * 0.5, oz);
        group.add(tree);
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.scale.set(tw * 0.18, h * 0.18, tw * 0.18);
        trunk.position.set(ox, groundY + h * 0.1, oz);
        group.add(trunk);
      }
    }

    // rocks
    const rockMat = themed(new THREE.MeshLambertMaterial(), 0x7a7f74, 0x262c2f);
    for (let i = 0; i < 12; i++) {
      const spot = scatter(Math.min(regionHalf * 0.6, 11000), 1500);
      if (!spot) continue;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), rockMat);
      const s = 12 + rnd() * 22;
      rock.scale.set(s, s * 0.7, s);
      rock.position.set(spot[0], baseY + this.heightAt(spot[0], spot[1]) + s * 0.35, spot[1]);
      group.add(rock);
    }

    // far hills — sparse relief toward the horizon, outside the heightfield
    const farMat = themed(new THREE.MeshLambertMaterial(), 0x38702f, 0x0c1e12);
    for (let i = 0; i < 40; i++) {
      const ringR = 34000 + rnd() * 44000;
      const a = rnd() * Math.PI * 2;
      const x = areaCX - 7500 + Math.cos(a) * ringR;
      const z = areaCZ - 7500 + Math.sin(a) * ringR;
      if (!clearOf(x, z, 3000)) continue;
      const w0 = 340 + rnd() * 420;
      const h0 = 30 + rnd() * 110;
      const far = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), farMat);
      far.scale.set(w0, h0, w0 * (0.8 + rnd() * 0.4));
      far.position.set(x, baseY + h0 * 0.5, z);
      group.add(far);
    }

    this.applyTerrainTheme(this.viewOptions.dayMode);
  }

  private applyTerrainTheme(day: boolean) {
    if (this.terrainMat) {
      this.terrainMat.color.setHex(day ? 0x4a8c3f : 0x0e1f14);
    }
    for (const t of this.terrainThemes) {
      t.mat.color.setHex(day ? t.day : t.night);
    }
  }

  private updateObstacles(
    obstacles: { id: string; kind: string; center: [number, number, number]; radius: number; height: number }[],
  ) {
    const incoming = new Set(obstacles.map((o) => o.id));
    const day = this.viewOptions.dayMode;

    for (const obs of obstacles) {
      if (this.obstacleGroups.has(obs.id)) continue;
      const group = new THREE.Group();
      const pos3 = toThree(obs.center);

      if (obs.kind === "AIRPORT") {
        const padColor = day ? 0x555555 : 0x1a2a1a;
        const pad = new THREE.Mesh(
          new THREE.CylinderGeometry(obs.radius * 0.55, obs.radius * 0.55, 40, 28),
          new THREE.MeshPhongMaterial({ color: padColor, opacity: 0.7, transparent: true }),
        );
        pad.position.copy(pos3).setY(pos3.y - obs.height * 0.35);
        group.add(pad);
        const rLen = obs.radius * 1.2;
        const rwyColor = day ? 0xeeeeee : 0xccccee;
        for (const angle of [0, Math.PI / 2]) {
          const rwy = new THREE.Mesh(
            new THREE.BoxGeometry(rLen, 6, 18),
            new THREE.MeshPhongMaterial({ color: rwyColor, opacity: 0.8, transparent: true }),
          );
          rwy.position.copy(pos3).setY(pos3.y - obs.height * 0.34);
          rwy.rotation.y = angle;
          group.add(rwy);
        }
        const labelColor = day ? 0x224422 : 0xccddcc;
        const label = makeTextSprite("AIRPORT", labelColor);
        label.position.copy(pos3).setY(pos3.y - obs.height * 0.2);
        label.scale.set(400, 150, 1);
        group.add(label);
      } else {
        const color = obs.kind === "NO_FLY" ? 0xff2222 : 0x9944cc;
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(obs.radius, obs.radius, obs.height, 24),
          new THREE.MeshPhongMaterial({ color, opacity: 0.2, transparent: true, side: THREE.DoubleSide }),
        );
        mesh.position.copy(pos3);
        group.add(mesh);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(obs.radius - 15, obs.radius, 48),
          new THREE.MeshBasicMaterial({ color, opacity: 0.4, transparent: true, side: THREE.DoubleSide }),
        );
        ring.position.copy(pos3).setY(pos3.y - obs.height / 2 + 10);
        ring.rotation.x = -Math.PI / 2;
        group.add(ring);
      }

      this.scene.add(group);
      this.obstacleGroups.set(obs.id, group);
    }

    for (const [id, group] of this.obstacleGroups) {
      if (!incoming.has(id)) {
        this.scene.remove(group);
        group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.obstacleGroups.delete(id);
      }
    }
  }

  private updateAircraft(aircraft: AircraftSnapshot[]) {
    const activeIds = new Set(aircraft.map((a) => a.id));
    for (const ac of aircraft) {
      let vis = this.aircraftMap.get(ac.id);
      if (!vis) {
        vis = new AircraftVisual(
          airportColorById(ac.origin_aid),
          airportColorById(ac.dest_aid),
        );
        this.scene.add(vis.group);
        vis.label.visible = this.viewOptions.showTags;
        this.aircraftMap.set(ac.id, vis);
      }
      vis.update(ac);
    }
    for (const [id, vis] of this.aircraftMap) {
      if (!activeIds.has(id)) {
        this.scene.remove(vis.group);
        vis.dispose();
        this.aircraftMap.delete(id);
      }
    }
  }

  private updateConflicts(aircraft: AircraftSnapshot[]) {
    this.conflictLines.forEach((l) => this.scene.remove(l));
    this.conflictLines = [];

    if (!this.viewOptions.showConflicts) return;

    const drawn = new Set<string>();
    for (const ac of aircraft) {
      for (const otherId of ac.conflict_with) {
        const key = [ac.id, otherId].sort().join("|");
        if (drawn.has(key)) continue;
        drawn.add(key);
        const other = this.aircraftMap.get(otherId);
        if (!other) continue;
        const geo = new THREE.BufferGeometry().setFromPoints([
          toThree(ac.position),
          other.group.position,
        ]);
        const line = new THREE.Line(
          geo,
          new THREE.LineBasicMaterial({ color: CONFLICT_COLOR, linewidth: 2, opacity: 0.75, transparent: true }),
        );
        this.scene.add(line);
        this.conflictLines.push(line);
      }
    }
  }

  private updateNeighborLines(aircraft: AircraftSnapshot[]) {
    this.neighborLines.forEach((l) => this.scene.remove(l));
    this.neighborLines = [];
    const drawn = new Set<string>();
    for (const ac of aircraft) {
      for (const nb of ac.neighbors.slice(0, 15)) {
        const key = [ac.id, nb.id].sort().join("|");
        if (drawn.has(key)) continue;
        drawn.add(key);
        const other = this.aircraftMap.get(nb.id);
        if (!other) continue;
        const color = nb.state === "ACTIVE" ? COMM_LINE_COLOR : STALE_LINE_COLOR;
        const geo = new THREE.BufferGeometry().setFromPoints([
          toThree(ac.position),
          other.group.position,
        ]);
        const line = new THREE.Line(
          geo,
          new THREE.LineBasicMaterial({ color, opacity: 0.15, transparent: true }),
        );
        this.scene.add(line);
        this.neighborLines.push(line);
      }
    }
  }

  private updateUncertainty(snapshot: SimSnapshot) {
    const staleIds = new Set<string>();
    for (const ac of snapshot.aircraft) {
      for (const nb of ac.neighbors) {
        if (nb.state !== "UNRESPONSIVE") continue;
        const radius = Math.min(150 + 40 * nb.age, 400);
        staleIds.add(nb.id);
        let mesh = this.uncertainMeshes.get(nb.id);
        if (!mesh) {
          mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 16, 12),
            new THREE.MeshBasicMaterial({
              color: 0xff5533,
              wireframe: true,
              transparent: true,
              opacity: 0.22,
              depthWrite: false,
            }),
          );
          this.scene.add(mesh);
          this.uncertainMeshes.set(nb.id, mesh);
        }
        const pos = this.aircraftMap.get(nb.id)?.group.position;
        if (pos) mesh.position.copy(pos);
        const prev = (mesh.userData.radius as number | undefined) ?? radius;
        if (Math.abs(prev - radius) > 10) {
          mesh.geometry.dispose();
          mesh.geometry = new THREE.SphereGeometry(radius, 16, 12);
        }
        mesh.userData.radius = radius;
      }
    }
    for (const [id, mesh] of this.uncertainMeshes) {
      if (!staleIds.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.uncertainMeshes.delete(id);
      }
    }
  }

  dispose() {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
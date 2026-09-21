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
import {
  buildStaticTerrainGeometry,
  createUnifiedHeightField,
  retargetTerrainRingFade,
  type StaticTerrainSpec,
} from "./terrainField";

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

const NIGHT_FOG_COLOR = 0x0e1818;
const DAY_FOG_COLOR = 0xcceeff;

// Atmospheric haze: distant terrain fades into the sky colour so the endless
// relief simply dissolves over the horizon instead of ending at a visible edge.
const FOG_NEAR = 35000;
const FOG_FAR = 340000;

/** 0xRRGGBB → { r, g, b } in [0, 1], matching the relief-colour authoring. */
const FOG_RGB = (hex: number) => ({
  r: ((hex >> 16) & 255) / 255,
  g: ((hex >> 8) & 255) / 255,
  b: (hex & 255) / 255,
});

// The ground extends far beyond the camera's max zoom so its edge is never
// visible — the world reads as endless even at the max zoom-out.
const GROUND_HALF_EXTENT = 1200000;
const GROUND_CLEARANCE = 80;

// One static, world-anchored terrain mesh (see buildStaticTerrainGeometry).
// The coarse ring must reach past the fog's far edge (FOG_FAR) so the world
// still dissolves at the horizon. The mesh is built once when the elevation
// grid loads and never rebuilt as the camera moves — no LOD pop, no airport
// slicing at window boundaries.
const TERRAIN_RING_REACH = 300000;

/** Yield to the render loop so a multi-batch build never freezes the UI. */
const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// How high above the terrain surface airport buildings sit. The backend sits
// the flattened field exactly AT every airport's base, so without this lift
// the pad disc and terminal bed are coplanar with the heightfield and
// z-fight their way into looking sunk in the ground.
const AIRPORT_GROUND_CLEARANCE = 4;

// How high above the terrain surface (or the flat ground plane, when terrain
// is disabled) the camera must stay. Prevents clipping through mountains and
// diving below the map; also keeps the near plane clear of steep slopes.
const MIN_CAMERA_CLEARANCE = 400;

// The procedural aircraft model is built ~390 m long at "airliner" scale, so
// a plane would dwarf the 50 m runways. Scale the body by this factor so the
// aircraft sits on the field like a real airliner (~40 m). Tags, prediction
// arrows and trails live on the unscaled outer group and stay readable.
const PLANE_SCALE = 0.1;

// The whole airport site renders ~2x bigger so each field reads as a proper
// airport now that the aircraft are ~40 m: pad, apron, terminal and beacon are
// scaled by this factor (runway length is real terrain, only its width and slab
// thickness grow). Keep in sync with backend terrain.terrace_radii — the flat
// terrace must stay bigger than radius * 1.2 * scale.
const AIRPORT_SITE_SCALE = 2;

// How far above the terrain surface grounded aircraft sit. Keeps parked /
// taxiing / lined-up craft clear of the heightfield, the airport decks and the
// runway slabs without z-fighting, and is the "never below the ground" floor
// any aircraft that dips under the local surface is clamped up to.
const GROUND_HOVER = 9;

// Sim (x, y, z_alt) → Three (x, z_alt + baseY, y). Every sim-space object
// shares the scene's ground datum — baseY (airspace.floor - GROUND_CLEARANCE)
// is exactly where the heightfield surface and airport decks are drawn — so
// nothing renders sunk relative to the terrain.
function toThree(pos: [number, number, number], baseY = 0): THREE.Vector3 {
  return new THREE.Vector3(pos[0], pos[2] + baseY, pos[1]);
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
  group.scale.setScalar(PLANE_SCALE);
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

  ctx.fillStyle = day ? "#c8b178" : "#1a3326";
  ctx.fillRect(0, 0, size, size);

  const patchCount = day ? 60 : 50;
  for (let i = 0; i < patchCount; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const w = 20 + Math.random() * 70;
    const h = 20 + Math.random() * 70;
    ctx.globalAlpha = 0.15 + Math.random() * 0.25;
    if (day) {
      ctx.fillStyle = `rgb(${185 + Math.floor(Math.random() * 35)},${165 + Math.floor(Math.random() * 30)},${95 + Math.floor(Math.random() * 35)})`;
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
      this.airplane.scale.setScalar(PLANE_SCALE);
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
    this.label.position.set(0, PLANE_SCALE * 320, 0);
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

  update(
    ac: AircraftSnapshot,
    baseY: number,
    surfaceYAt: (sx: number, sy: number) => number | null,
  ) {
    const pos = toThree(ac.position, baseY);
    // Terrain clamping: sit ground-phase aircraft on the local surface (with
    // a small hover so they read as parked), and lift ANY aircraft that would
    // otherwise render below the field. surfaceYAt is null until the backend
    // elevation grid arrives, at which point planes settle onto the terrain.
    const surf = surfaceYAt(ac.position[0], ac.position[1]);
    if (surf !== null) {
      const minY = surf + GROUND_HOVER;
      if (GROUND_PHASES.has(ac.phase) || pos.y < minY) pos.y = minY;
    }
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

    const dest = toThree(ac.destination, baseY);
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
      const wp = toThree(ac.waypoint, baseY);
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
  skyStarField: THREE.Points | null = null;
  skySun: THREE.Sprite | null = null;
  groundMesh: THREE.Mesh | null = null;
  terrainGroup: THREE.Group | null = null;

  private terrainMat: THREE.MeshLambertMaterial | null = null;
  private heightAt: (sx: number, sy: number) => number = () => 0;
  private terrainGrid: Float32Array | null = null;
  private terrainMeta: TerrainMeta | null = null;
  terrainMesh: THREE.Mesh | null = null;

  /** In-flight terrain build (dedupes concurrent ensureTerrain calls). */
  private terrainBuildPromise: Promise<void> | null = null;
  private terrainReady = false;
  private airportGroups: Map<string, THREE.Group> = new Map();
  private airportThemes: Map<string, ThemedMat[]> = new Map();
  private terrainThemes: ThemedMat[] = [];

  /** The scene's ground datum: sim altitude z renders at world Y = baseY + z. */
  private baseY(): number {
    return (this.lastSnapshot?.airspace.floor ?? 100) - GROUND_CLEARANCE;
  }

  /**
   * World Y of the terrain surface at a sim point, or null until the backend
   * elevation grid has loaded. Used to clamp aircraft (and equivalent to the
   * airport decks' ground plane) onto the field.
   */
  private groundSurfaceY(sx: number, sy: number): number | null {
    if (!this.terrainMeta || !this.terrainGrid) return null;
    return this.baseY() + this.heightAt(sx, sy);
  }

  private lastSnapshot: SimSnapshot | null = null;

  viewOptions: ViewOptions = { dayMode: false, showConflicts: true, showTags: true };

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(NIGHT_FOG_COLOR);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(NIGHT_FOG_COLOR, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 50, 600000);
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
      // Unified height field: authoritative bilinear inside the backend grid,
      // easing into deterministic procedural relief beyond it (endless world).
      const air = this.lastSnapshot?.airspace;
      const cx = air ? air.width / 2 : meta.x0 + (meta.width * meta.cell) / 2;
      const cy = air ? air.depth / 2 : meta.y0 + (meta.height * meta.cell) / 2;
      this.heightAt = createUnifiedHeightField(meta, this.terrainGrid, cx, cy).heightAt;
      // The heightfield is now the single ground surface: drop the flat
      // fallback plane that may have been drawn while the grid was loading.
      this.removeGround();
      // Rebuild the static terrain from the new grid (chunked). No-op until a
      // snapshot is present; update() kicks it off once dimensions are known.
      await this.ensureTerrain();
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
      this.camera.position.set(cx, 19000, cz + 32000);
      this.controls.target.set(cx, 600, cz);
    } else {
      this.camera.position.set(6000, 9000, 18000);
      this.controls.target.set(7500, 1500, 7500);
    }
    this.snapOrbitTargetToTerrain();
    this.controls.update();
  }

  private rebuildEnvironment() {
    const day = this.viewOptions.dayMode;
    const clearColor = day ? DAY_FOG_COLOR : NIGHT_FOG_COLOR;

    this.renderer.setClearColor(clearColor);
    if (this.scene.fog) this.scene.fog.color.setHex(clearColor);

// Scene lighting: daytime sun keeps the full day values; at night a bright
    // blue moon keeps the terrain/ground clearly visible, while the glowing
    // beacons and aircraft tags still read as the focal points.
    this.sunLight.intensity = day ? 0.85 : 0.8;
    this.sunLight.color.setHex(day ? 0xfff8e8 : 0xaec2e2);
    this.ambient.intensity = day ? 0.35 : 0.45;
    this.ambient.color.setHex(day ? 0xffffff : 0x39466e);
    this.hemi.intensity = day ? 0.3 : 0.55;
    this.hemi.color.setHex(day ? 0x8888ff : 0x31405e);
    this.hemi.groundColor.setHex(day ? 0x443322 : 0x141a24);

    this.rebuildBounds();
    this.rebuildSky();
    this.rebuildGround();
    this.applyTerrainTheme(day);
    this.applyAirportTheme(day);
  }

  private rebuildSky() {
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

    const air = this.lastSnapshot?.airspace ?? { width: 15000, depth: 15000, ceiling: 5000 };
    const w = air.width;
    const d = air.depth;
    const ceiling = air.ceiling;
    const radius = 55000;

    if (!day) {
      const verts: number[] = [];
      for (let i = 0; i < 500; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 0.85 + 0.15);
        const r = radius * 0.95;
        verts.push(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.cos(phi),
          r * Math.sin(phi) * Math.sin(theta),
        );
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      const starMat = new THREE.PointsMaterial({ color: 0xaabbee, size: 45, sizeAttenuation: true, fog: false });
      starMat.depthWrite = false;
      const stars = new THREE.Points(starGeo, starMat);
      stars.position.copy(this.camera.position);
      stars.renderOrder = -1;
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

  /** True once the authoritative backend elevation grid is loaded. At that
   * point the heightfield is the ground — the flat plane below is dropped so
   * only one visible ground surface exists at any world position. */
  private terrainEnabled(): boolean {
    return !!this.terrainMeta && !!this.terrainGrid;
  }

  private removeGround() {
    if (this.groundMesh) {
      this.scene.remove(this.groundMesh);
      (this.groundMesh.material as THREE.MeshLambertMaterial).map?.dispose();
      (this.groundMesh.material as THREE.Material).dispose();
      this.groundMesh.geometry.dispose();
      this.groundMesh = null;
    }
  }

  private rebuildGround() {
    this.removeGround();
    // Heightfield is the authoritative ground surface wherever terrain is
    // enabled; the flat fallback plane only exists without it (never render
    // both over the same (x, z)).
    if (this.terrainEnabled()) return;

    const day = this.viewOptions.dayMode;
    const width = this.lastSnapshot?.airspace.width ?? 15000;
    const depth = this.lastSnapshot?.airspace.depth ?? 15000;
    const floor = this.lastSnapshot?.airspace.floor ?? 100;

    const size = GROUND_HALF_EXTENT * 2;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const tex = makeGroundTexture(day);
    const tileMetres = 2400;
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

  /**
   * Keep the camera above the terrain surface everywhere on the map: never
   * inside a mountain and never under the ground plane. When the elevation
   * grid is missing, heightAt returns 0, so the floor becomes the flat
   * ground plane itself (airspace.flooor - GROUND_CLEARANCE). After lifting
   * the camera we re-run controls.update() so OrbitControls' internal
   * spherical state matches the new position instead of fighting it.
   */
  private clampCameraToTerrain() {
    const cam = this.camera.position;
    const floor = this.lastSnapshot?.airspace.floor ?? 100;
    const baseY = floor - GROUND_CLEARANCE;
    const surfaceY = baseY + this.heightAt(cam.x, cam.z);
    const minY = surfaceY + MIN_CAMERA_CLEARANCE;
    if (cam.y < minY) {
      cam.y = minY;
      this.controls.update();
    }
  }

  /**
   * Keep the orbit pivot on (not under) the terrain surface. The default pivot
   * is a fixed low altitude, but the map centre can be a ~3.5 km peak; a target
   * buried under it makes every wheel-zoom stall against clampCameraToTerrain.
   * No-op until the authoritative grid is loaded.
   */
  private snapOrbitTargetToTerrain() {
    if (!this.terrainEnabled()) return;
    const t = this.controls.target;
    t.y = this.baseY() + this.heightAt(t.x, t.z) + MIN_CAMERA_CLEARANCE;
    this.controls.update();
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.clampCameraToTerrain();
    // Skybox: keep the stars centred on the viewer so zooming out
    // or panning across the 160 km world can never walk out of them.
    if (this.skyStarField) this.skyStarField.position.copy(this.camera.position);
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
    this.camera.position.set(cx, 19000, cz + 32000);
    this.controls.target.set(cx, 600, cz);
    this.snapOrbitTargetToTerrain();
    this.controls.update();
  }

  private updateBounds(width: number, depth: number, floor: number, _ceiling: number) {
    if (this.boundsGroup.userData.boundsBuilt) return;
    this.boundsGroup.userData.boundsBuilt = true;
    const day = this.viewOptions.dayMode;
    const gridColor1 = day ? 0x88aaaa : 0x222244;
    const gridColor2 = day ? 0x667777 : 0x111133;
    const grid = new THREE.GridHelper(Math.max(width, depth), 640, gridColor1, gridColor2);
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
    if (!this.skySun) {
      this.rebuildSky();
    }
  }

  private updateGroundIfNeeded() {
    // Once the elevation grid is here the heightfield owns the ground;
    // tear down any flat plane left over from the pre-grid frames.
    if (this.terrainEnabled()) {
      this.removeGround();
      return;
    }
    if (!this.groundMesh) {
      this.rebuildGround();
    }
  }

  // ────── airports ──────

  /**
   * Surface an airport sits on: the backend-flattened field elevation, raised
   * clear of the terrain (AIRPORT_GROUND_CLEARANCE) so the pad and terminal
   * bed read as placed on the field instead of coplanar/sunk into it. Uses the
   * exact same datum as the heightfield (baseY + heightAt(x, z)) — the backend
   * raises the grid onto a flat terrace where heightAt(center) == center[2] —
   * so the `Math.max` is a no-op once the grid is loaded and only keeps the
   * field from floating *below* its own base before the grid arrives. Never
   * sinks below the airport's own altitude (center[2]) no matter the flatten
   * tolerance or grid timing.
   */
  private airportGroundY(apt: Airport): number {
    return this.baseY() + Math.max(this.heightAt(apt.center[0], apt.center[1]), apt.center[2]) + AIRPORT_GROUND_CLEARANCE;
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
    const S = AIRPORT_SITE_SCALE;

    const padMat = new THREE.MeshPhongMaterial({ opacity: 0.85, transparent: true });
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(apt.radius * 0.62 * S, apt.radius * 0.62 * S, 26 * S, 28),
      padMat,
    );
    pad.position.set(px, groundY + 13 * S, pz);
    pad.receiveShadow = true;
    pad.castShadow = true;
    group.add(pad);
    themes.push({ mat: padMat, day: 0x595961, night: 0x1a2026, closed: 0x5a2f2b });

    if (apt.hub) {
      const hubMat = new THREE.MeshPhongMaterial({ opacity: 0.5, transparent: true });
      const apron = new THREE.Mesh(
        new THREE.RingGeometry(apt.radius * 1.05 * S, apt.radius * 1.2 * S, 48),
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
      const strip = new THREE.Mesh(new THREE.BoxGeometry(r.length, 2 * S, 46 * S), stripMat);
      strip.position.set(cx, groundY + 2 * S, cz);
      strip.rotation.y = rotY;
      strip.receiveShadow = true;
      group.add(strip);
      themes.push({ mat: stripMat, day: 0x3a3d42, night: 0x14161a, closed: 0x4a2f2c });

      const lineMat = new THREE.MeshPhongMaterial({ opacity: 0.95, transparent: true });
      const line = new THREE.Mesh(new THREE.BoxGeometry(r.length, 1.4 * S, 5 * S), lineMat);
      line.position.set(cx, groundY + 2.8 * S, cz);
      line.rotation.y = rotY;
      group.add(line);
      themes.push({ mat: lineMat, day: 0xe8e8e8, night: 0x99a4b3, closed: 0xbb7777 });
    }

    const termMat = new THREE.MeshPhongMaterial();
    const term = new THREE.Mesh(new THREE.BoxGeometry(140 * S, 60 * S, 80 * S), termMat);
    term.position.set(px + apt.radius * 0.62 * S * 0.55, groundY + 30 * S, pz);
    term.castShadow = true;
    term.receiveShadow = true;
    group.add(term);
    themes.push({ mat: termMat, day: 0x9aa0a6, night: 0x22262c, closed: 0x74423b });

    const roofMat = new THREE.MeshPhongMaterial();
    const roof = new THREE.Mesh(new THREE.BoxGeometry(150 * S, 12 * S, 92 * S), roofMat);
    roof.position.set(px + apt.radius * 0.62 * S * 0.55, groundY + 62 * S, pz);
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
    const ring = new THREE.Mesh(new THREE.RingGeometry(apt.radius * 0.74 * S, apt.radius * 0.82 * S, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(px, groundY + 26 * S, pz);
    group.add(ring);
    themes.push({ mat: ringMat, day: beaconColor, night: beaconColor, closed: 0x3a3a3a });

    const beaconMat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: beaconColor,
      emissiveIntensity: 0.8,
    });
    const beacon = new THREE.Mesh(new THREE.ConeGeometry(16 * S, 40 * S, 8), beaconMat);
    beacon.position.set(px + apt.radius * 0.62 * S * 0.55, groundY + 92 * S, pz);
    group.add(beacon);
    themes.push({ mat: beaconMat, day: 0xffffff, night: 0xffffff, closed: 0x666666 });

    const label = makeTextSprite(
      apt.closed ? "CLOSED" : apt.hub ? `${apt.name} · HUB` : apt.name,
      0xffffff,
    );
    label.position.set(px, groundY + 110 * S, pz);
    label.scale.set(430 * S, 180 * S, 1);
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

  /**
   * Build the static terrain once the authoritative grid is ready. The build
   * is chunked and async (UI stays responsive); concurrent callers share the
   * in-flight promise. Passed a snapshot, the terrain uses its dimensions for
   * baseY and clears decorations from airports.
   */
  private ensureTerrain() {
    if (this.terrainReady) return;
    // No authoritative grid → the backend has no terrain; stay flat on the
    // ground plane and match the backend's behaviour.
    if (!this.terrainMeta || !this.terrainGrid) return;
    if (!this.terrainBuildPromise) {
      this.terrainBuildPromise = (async () => {
        try {
          await this.buildTerrainFromGrid();
        } catch (err) {
          console.error("[terrain] build failed", err);
        } finally {
          this.terrainBuildPromise = null;
        }
      })();
    }
    return this.terrainBuildPromise;
  }

  /** Remove and dispose every terrain visual (mesh, decor, materials). */
  private disposeTerrain() {
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
      this.terrainGroup = null;
      this.terrainMesh = null;
    }
    this.terrainMat = null;
    this.terrainThemes = [];
    this.terrainReady = false;
  }

  /** Rebuild the static terrain from the authoritative elevation grid. */
  private async buildTerrainFromGrid() {
    const air = this.lastSnapshot?.airspace;
    if (!air) return; // wait for a snapshot so dimensions/airports are known
    this.disposeTerrain();

    const meta = this.terrainMeta!;
    const baseY = air.floor - GROUND_CLEARANCE;
    const areaCX = air.width / 2;
    const areaCZ = air.depth / 2;
    const rnd = mulberry32(1337);
    const regionHalf = Math.round((meta.height - 1) * meta.cell / 2);

    const airports = air.airports.map((a) => ({
      lx: a.center[0] - areaCX,
      lz: a.center[1] - areaCZ,
      r: a.radius,
    }));

    // ── static heightfield: one world-anchored structured grid (fine over
    // the backend grid, coarsening ring beyond), built once. It never moves
    // or re-tessellates with the camera, so there is no LOD pop and airports
    // can never be sliced by a window boundary.
    const group = new THREE.Group();
    this.terrainGroup = group;
    this.scene.add(group);
    this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });

    const spec: StaticTerrainSpec = {
      coreCell: meta.cell,
      ringCell: meta.cell * 8,
      ringReach: TERRAIN_RING_REACH,
    };
    const geo = await buildStaticTerrainGeometry(
      meta,
      this.heightAt,
      baseY,
      spec,
      yieldToMain,
      FOG_RGB(this.viewOptions.dayMode ? DAY_FOG_COLOR : NIGHT_FOG_COLOR),
    );
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    this.terrainMesh = mesh;

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
    const treeMat = themed(new THREE.MeshLambertMaterial(), 0x8a7a4a, 0x0e2416);
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

    this.applyTerrainTheme(this.viewOptions.dayMode);
    // Lift the orbit pivot out of any terrain it currently sits below, so
    // zooming toward the map centre can reach the ground instead of stalling
    // on the camera clamp above the newly-built surface.
    this.snapOrbitTargetToTerrain();
    this.terrainReady = true;
  }

  private applyTerrainTheme(day: boolean) {
    if (this.terrainMesh) {
      retargetTerrainRingFade(this.terrainMesh.geometry, FOG_RGB(day ? DAY_FOG_COLOR : NIGHT_FOG_COLOR));
    }
    if (this.terrainMat) {
      this.terrainMat.color.setHex(day ? 0xffffff : 0x9fb0c4);
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
      const pos3 = toThree(obs.center, this.baseY());

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
    const baseY = this.baseY();
    const surfaceYAt = (sx: number, sy: number) => this.groundSurfaceY(sx, sy);
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
      vis.update(ac, baseY, surfaceYAt);
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
        const self = this.aircraftMap.get(ac.id);
        const geo = new THREE.BufferGeometry().setFromPoints([
          self ? self.group.position : toThree(ac.position, this.baseY()),
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
        const self = this.aircraftMap.get(ac.id);
        const geo = new THREE.BufferGeometry().setFromPoints([
          self ? self.group.position : toThree(ac.position, this.baseY()),
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
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
import type { SimSnapshot, AircraftSnapshot, Airport } from "../api/types";

const COMM_LINE_COLOR = 0x336688;
const STALE_LINE_COLOR = 0x995533;
const CONFLICT_COLOR = 0xff2222;
const WAYPOINT_COLOR = 0xffaa44;

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

function smoothstep01(t: number): number {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
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

/**
 * A tiling value-noise field plus fbm helpers used to sculpt the terrain
 * heightfield. Lattice wraps at 256 cells so octaves with integer frequency
 * stay seamless.
 */
function makeNoiseField(seed: number) {
  const CW = 256;
  const rnd = mulberry32(seed);
  const lattice = new Float64Array(CW * CW);
  for (let i = 0; i < CW * CW; i++) lattice[i] = rnd();

  function value(x: number, y: number): number {
    const xi = ((Math.floor(x) % CW) + CW) % CW;
    const yi = ((Math.floor(y) % CW) + CW) % CW;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = lattice[yi * CW + xi];
    const b = lattice[yi * CW + ((xi + 1) % CW)];
    const c = lattice[((yi + 1) % CW) * CW + xi];
    const d = lattice[((yi + 1) % CW) * CW + ((xi + 1) % CW)];
    const top = a + (b - a) * sx;
    const bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  }

  function fbm(x: number, y: number, octaves: number): number {
    let s = 0;
    let n = 0;
    let a = 1;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      s += a * value(x * f, y * f);
      n += a;
      a *= 0.5;
      f *= 2;
    }
    return s / n;
  }

  function ridged(x: number, y: number, octaves: number): number {
    let s = 0;
    let n = 0;
    let a = 1;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      const v = value(x * f, y * f);
      let r = 1 - Math.abs(2 * v - 1);
      r *= r;
      s += a * r;
      n += a;
      a *= 0.5;
      f *= 2;
    }
    return s / n;
  }

  return { value, fbm, ridged };
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
  airplaneMat: THREE.MeshPhongMaterial;
  velocityLine: THREE.Line;
  destinationLine: THREE.Line;
  waypointLine: THREE.Line;
  trailPoints: THREE.Vector3[] = [];
  trailLine: THREE.Line;

  private originColor: THREE.Color;
  private destColor: THREE.Color;
  private smoothHeading: number | null = null;
  private bankAngle = 0;

  constructor(originColor: number, destColor: number) {
    this.group = new THREE.Group();
    this.originColor = new THREE.Color(originColor);
    this.destColor = new THREE.Color(destColor);
    const { group, mat } = buildAirplane(originColor);
    this.airplane = group;
    this.airplaneMat = mat;
    this.group.add(this.airplane);

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

    // Body colour fades from origin airport to destination airport across the leg.
    this.airplaneMat.color.copy(this.originColor).lerp(this.destColor, clamp01(ac.progress));
    this.airplaneMat.emissive.setHex(ac.emergency ? 0xff2222 : 0x000000);

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
  }
}

// ────── SkyScene ──────

export interface ViewOptions {
  dayMode: boolean;
  showConflicts: boolean;
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

  boundsGroup: THREE.Group;
  skyMesh: THREE.Mesh | null = null;
  skyStarField: THREE.Points | null = null;
  skySun: THREE.Sprite | null = null;
  groundMesh: THREE.Mesh | null = null;
  terrainGroup: THREE.Group | null = null;

  private terrainMat: THREE.MeshLambertMaterial | null = null;
  private heightAt: (sx: number, sy: number) => number = () => 0;
  private airportGroups: Map<string, THREE.Group> = new Map();
  private airportThemes: Map<string, ThemedMat[]> = new Map();
  private terrainThemes: ThemedMat[] = [];

  private lastSnapshot: SimSnapshot | null = null;

  viewOptions: ViewOptions = { dayMode: false, showConflicts: true };

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
    this.controls.maxDistance = 50000;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
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
    this.scene.add(new THREE.HemisphereLight(0x8888ff, 0x443322, 0.3));

    this.boundsGroup = new THREE.Group();
    this.scene.add(this.boundsGroup);

    window.addEventListener("resize", this.onResize);
    this.animate();
  }

  setOptions(opts: Partial<ViewOptions>) {
    const prev = { ...this.viewOptions };
    if (opts.dayMode !== undefined) this.viewOptions.dayMode = opts.dayMode;
    if (opts.showConflicts !== undefined) this.viewOptions.showConflicts = opts.showConflicts;

    if (prev.dayMode !== this.viewOptions.dayMode) {
      this.rebuildEnvironment();
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
    this.camera.position.set(6000, 9000, 18000);
    this.controls.target.set(7500, 1500, 7500);
    this.controls.update();
  }

  private rebuildEnvironment() {
    const day = this.viewOptions.dayMode;
    const clearColor = day ? DAY_CLEAR : NIGHT_CLEAR;

    this.renderer.setClearColor(clearColor);
    (this.scene.fog as THREE.FogExp2).color.setHex(clearColor);
    (this.scene.fog as THREE.FogExp2).density = day ? DAY_FOG_DENSITY : NIGHT_FOG_DENSITY;

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
    this.updateSkyIfNeeded();
    this.updateGroundIfNeeded();
    this.ensureTerrain();
    this.updateAirports(snapshot.airspace.airports);
    this.updateObstacles(snapshot.airspace.obstacles);
    this.updateAircraft(snapshot.aircraft);
    this.updateConflicts(snapshot.aircraft);
    this.updateNeighborLines(snapshot.aircraft);
    this.updateUncertainty(snapshot);
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
    const air = this.lastSnapshot!.airspace;
    const groundY = air.floor - GROUND_CLEARANCE;
    const group = new THREE.Group();
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

    const rLen = apt.radius * 1.3;
    for (const angle of [0, Math.PI / 2]) {
      const rwyMat = new THREE.MeshPhongMaterial({ opacity: 0.85, transparent: true });
      const rwy = new THREE.Mesh(new THREE.BoxGeometry(rLen, 6, 26), rwyMat);
      rwy.position.set(px, groundY + 16, pz);
      rwy.rotation.y = angle;
      rwy.receiveShadow = true;
      group.add(rwy);
      themes.push({ mat: rwyMat, day: 0xe2e2e2, night: 0x8a95a8, closed: 0xbb7777 });
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
    ring.position.set(px, groundY + 20, pz);
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

    const label = makeTextSprite(apt.closed ? "CLOSED" : apt.name, 0xffffff);
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

  // ────── terrain (real heightfield: hill ranges, mountain ranges) ──────

  private ensureTerrain() {
    if (this.terrainGroup) return;
    const air = this.lastSnapshot!.airspace;
    const group = new THREE.Group();
    this.terrainGroup = group;
    this.scene.add(group);

    const rnd = mulberry32(1337);
    const noise = makeNoiseField(1337);
    const areaCX = air.width / 2;
    const areaCZ = air.depth / 2;
    const regionHalf = 22000;
    const MAXH = 720;
    const baseY = air.floor - GROUND_CLEARANCE;
    const airports = air.airports.map((a) => ({
      lx: a.center[0] - areaCX,
      lz: a.center[1] - areaCZ,
      r: a.radius,
    }));

    const hillBands = [
      { angle: 0.25, period: 3400, amp: 150 },
      { angle: 1.15, period: 4600, amp: 130 },
      { angle: -0.8, period: 5200, amp: 110 },
      { angle: 2.2, period: 3000, amp: 90 },
      { angle: -2.0, period: 6400, amp: 100 },
    ];
    const spines = [
      { angle: -0.45, width: 4300, amp: 560, scale: 2700 },
      { angle: 0.9, width: 3400, amp: 460, scale: 2300 },
      { angle: 2.35, width: 5000, amp: 660, scale: 3100 },
    ];

    this.heightAt = (sx: number, sy: number) => {
      const lx = sx - areaCX;
      const ly = sy - areaCZ;

      let h = (noise.fbm(lx / 1100, ly / 1100, 3) - 0.5) * 26; // meadow bump ±13

      for (const b of hillBands) {
        const along = lx * Math.cos(b.angle) + ly * Math.sin(b.angle);
        h += Math.sin((along / b.period) * Math.PI * 2) * b.amp;
      }

      for (const s of spines) {
        const across = -lx * Math.sin(s.angle) + ly * Math.cos(s.angle);
        const band = Math.exp(-(across * across) / (2 * s.width * s.width));
        if (band < 0.02) continue;
        const along = lx * Math.cos(s.angle) + ly * Math.sin(s.angle);
        h += band * s.amp * noise.ridged(along / s.scale, across / s.scale, 4);
      }

      // Flatten around airports so runways sit exactly level.
      for (const a of airports) {
        const d = Math.hypot(lx - a.lx, ly - a.lz);
        const R = a.r * 1.5;
        if (d < R) h *= smoothstep01(d / R);
      }

      // Fade to the flat infinite plane at the rim, dipping just under it so
      // the two surfaces never z-fight along the seam.
      const n = Math.max(Math.abs(lx), Math.abs(ly)) / regionHalf;
      const eff = smoothstep01((n - 0.82) / 0.18);
      h = h * (1 - eff) - 2 * eff;

      return Math.max(-2, Math.min(MAXH, h));
    };

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

        // Vertex tint: subtle rocky crests above ~480 m, rest stays ground-green.
        const crest = clamp01((hgt - 480) / (MAXH - 480));
        const vib = 0.05 * (noise.fbm(sx / 700, sy / 700, 2) - 0.5);
        colors[i * 3 + 0] = 1 - 0.3 * crest + vib;
        colors[i * 3 + 1] = 1 - 0.2 * crest + vib;
        colors[i * 3 + 2] = 1 - 0.4 * crest + vib;
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
    heightfield.castShadow = true;
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

    // trees in small clusters, snapped onto the terrain surface
    const treeMat = themed(new THREE.MeshLambertMaterial(), 0x2f6b2f, 0x0e2416);
    const trunkMat = themed(new THREE.MeshLambertMaterial(), 0x6b5233, 0x241a0e);
    const treeGeo = new THREE.ConeGeometry(1, 1, 5);
    const trunkGeo = new THREE.CylinderGeometry(1, 1, 1, 5);
    for (let i = 0; i < 30; i++) {
      const spot = scatter(9000, 1700);
      if (!spot) continue;
      const n = 3 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) {
        const ox = spot[0] + (rnd() * 2 - 1) * 260;
        const oz = spot[1] + (rnd() * 2 - 1) * 260;
        if (!clearOf(ox, oz, 1300)) continue;
        const h = 34 + rnd() * 26;
        const tw = h * (0.45 + rnd() * 0.2);
        const groundY = baseY + this.heightAt(ox, oz);
        const tree = new THREE.Mesh(treeGeo, treeMat);
        tree.scale.set(tw, h, tw);
        tree.position.set(ox, groundY + h * 0.5, oz);
        tree.castShadow = true;
        group.add(tree);
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.scale.set(tw * 0.18, h * 0.18, tw * 0.18);
        trunk.position.set(ox, groundY + h * 0.1, oz);
        trunk.castShadow = true;
        group.add(trunk);
      }
    }

    // rocks
    const rockMat = themed(new THREE.MeshLambertMaterial(), 0x7a7f74, 0x262c2f);
    for (let i = 0; i < 12; i++) {
      const spot = scatter(11000, 1500);
      if (!spot) continue;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), rockMat);
      const s = 12 + rnd() * 22;
      rock.scale.set(s, s * 0.7, s);
      rock.position.set(spot[0], baseY + this.heightAt(spot[0], spot[1]) + s * 0.35, spot[1]);
      rock.castShadow = true;
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
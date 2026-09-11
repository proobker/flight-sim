/**
 * SkyScene — Three.js 3D visualization of the SkyMesh airspace.
 *
 * Renders airplane markers, predicted trajectory vectors, conflict lines,
 * communication links, obstacles, uncertainty regions, destination markers,
 * avoidance waypoints, sky dome, stars, sun, and a textured ground plane.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SimSnapshot, AircraftSnapshot } from "../api/types";

const PRIORITY_COLORS = [0xaaddff, 0xffaa44, 0x44dd88, 0xffdd44, 0xff4444];
const COMM_LINE_COLOR = 0x336688;
const STALE_LINE_COLOR = 0x995533;
const CONFLICT_COLOR = 0xff2222;
const WAYPOINT_COLOR = 0xffaa44;

// Sim (x, y, z_alt) → Three (x, z_alt, y)
function toThree(pos: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(pos[0], pos[2], pos[1]);
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

function makeGroundTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0e1f14";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 50; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const w = 20 + Math.random() * 60;
    const h = 20 + Math.random() * 60;
    ctx.globalAlpha = 0.3 + Math.random() * 0.3;
    ctx.fillStyle = `rgb(${10 + Math.floor(Math.random() * 18)},${22 + Math.floor(Math.random() * 22)},${8 + Math.floor(Math.random() * 14)})`;
    ctx.fillRect(x, y, w, h);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(55,75,45,0.25)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.random() * size, 0);
    ctx.lineTo(Math.random() * size, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, Math.random() * size);
    ctx.lineTo(size, Math.random() * size);
    ctx.stroke();
  }
  return new THREE.CanvasTexture(canvas);
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

function makeDestMarker(color: number): THREE.Group {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(5, 5, 240, 6),
    new THREE.MeshPhongMaterial({ color: 0x666688 }),
  );
  pole.position.y = 120;
  group.add(pole);
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(18, 38, 8),
    new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.3 }),
  );
  head.position.y = 270;
  group.add(head);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(28, 42, 24),
    new THREE.MeshBasicMaterial({ color, opacity: 0.35, transparent: true, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 2;
  group.add(ring);
  return group;
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

  constructor(priority: number) {
    this.group = new THREE.Group();
    const color = PRIORITY_COLORS[priority] ?? 0xaaddff;
    const { group, mat } = buildAirplane(color);
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

    this.airplane.rotation.set(0, -ac.heading, 0);
    this.airplaneMat.color.setHex(PRIORITY_COLORS[ac.priority] ?? 0xaaddff);
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

    this.trailPoints.push(pos.clone());
    if (this.trailPoints.length > 30) this.trailPoints.shift();
    if (this.trailPoints.length > 1) {
      const local = this.trailPoints.map((p) => p.clone().sub(pos));
      this.trailLine.geometry.dispose();
      this.trailLine.geometry = new THREE.BufferGeometry().setFromPoints(local);
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

export class SkyScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  container: HTMLElement;

  aircraftMap: Map<string, AircraftVisual> = new Map();
  destMarkers: Map<string, THREE.Group> = new Map();
  conflictLines: THREE.Line[] = [];
  neighborLines: THREE.Line[] = [];
  obstacleGroups: Map<string, THREE.Group> = new Map();
  uncertainMeshes: Map<string, THREE.Mesh> = new Map();

  boundsGroup: THREE.Group;
  skyDone = false;
  groundDone = false;

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0a0a1a);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a0a1a, 0.000022);

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
    this.scene.add(dir);
    this.scene.add(new THREE.HemisphereLight(0x8888ff, 0x443322, 0.3));

    this.boundsGroup = new THREE.Group();
    this.scene.add(this.boundsGroup);

    window.addEventListener("resize", this.onResize);
    this.animate();
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
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
    const { width, depth, floor, ceiling } = snapshot.airspace;
    this.updateBounds(width, depth, floor, ceiling);
    this.updateSky(width, depth, ceiling);
    this.updateGround(width, depth, floor);
    this.updateObstacles(snapshot.airspace.obstacles);
    this.updateAircraft(snapshot.aircraft);
    this.updateConflicts(snapshot.aircraft);
    this.updateNeighborLines(snapshot.aircraft);
    this.updateUncertainty(snapshot);
    this.updateDestMarkers(snapshot.aircraft);
  }

  private updateBounds(width: number, depth: number, floor: number, ceiling: number) {
    if (this.boundsGroup.children.length > 0) return;
    const grid = new THREE.GridHelper(Math.max(width, depth), 30, 0x222244, 0x111133);
    grid.position.set(width / 2, floor, depth / 2);
    this.boundsGroup.add(grid);
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(width, ceiling - floor, depth));
    const box = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x334466, opacity: 0.2, transparent: true }),
    );
    box.position.set(width / 2, (floor + ceiling) / 2, depth / 2);
    this.boundsGroup.add(box);
  }

  private updateSky(width: number, depth: number, ceiling: number) {
    if (this.skyDone) return;
    this.skyDone = true;
    const radius = 55000;
    const geo = new THREE.SphereGeometry(radius, 28, 18);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x071030) },
        midColor: { value: new THREE.Color(0x1a3050) },
        bottomColor: { value: new THREE.Color(0x0e1818) },
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
    sky.position.set(width / 2, ceiling / 2, depth / 2);
    this.scene.add(sky);

    // stars
    const verts: number[] = [];
    for (let i = 0; i < 500; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.85 + 0.15);
      const r = radius * 0.95;
      verts.push(
        r * Math.sin(phi) * Math.cos(theta) + width / 2,
        r * Math.cos(phi) + ceiling / 2,
        r * Math.sin(phi) * Math.sin(theta) + depth / 2,
      );
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    this.scene.add(
      new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({ color: 0xaabbee, size: 45, sizeAttenuation: true, fog: false }),
      ),
    );

    // sun sprite
    const sun = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeSunTexture(),
        color: 0xffffee,
        fog: false,
        transparent: true,
        opacity: 0.85,
      }),
    );
    sun.position.set(width * 1.5, ceiling * 3, depth * 0.5);
    sun.scale.set(6000, 6000, 1);
    this.scene.add(sun);
  }

  private updateGround(width: number, depth: number, floor: number) {
    if (this.groundDone) return;
    this.groundDone = true;
    const size = Math.max(width, depth) * 1.6;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      map: makeGroundTexture(),
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(width / 2, floor - 80, depth / 2);
    this.scene.add(mesh);
  }

  private updateObstacles(
    obstacles: { id: string; kind: string; center: [number, number, number]; radius: number; height: number }[],
  ) {
    const incoming = new Set(obstacles.map((o) => o.id));

    for (const obs of obstacles) {
      if (this.obstacleGroups.has(obs.id)) continue;
      const group = new THREE.Group();
      const pos3 = toThree(obs.center);

      if (obs.kind === "AIRPORT") {
        const pad = new THREE.Mesh(
          new THREE.CylinderGeometry(obs.radius * 0.55, obs.radius * 0.55, 40, 28),
          new THREE.MeshPhongMaterial({ color: 0x1a2a1a, opacity: 0.5, transparent: true }),
        );
        pad.position.copy(pos3).setY(pos3.y - obs.height * 0.35);
        group.add(pad);
        const rLen = obs.radius * 1.2;
        for (const angle of [0, Math.PI / 2]) {
          const rwy = new THREE.Mesh(
            new THREE.BoxGeometry(rLen, 6, 18),
            new THREE.MeshPhongMaterial({ color: 0xccccee, opacity: 0.6, transparent: true }),
          );
          rwy.position.copy(pos3).setY(pos3.y - obs.height * 0.34);
          rwy.rotation.y = angle;
          group.add(rwy);
        }
        const label = makeTextSprite("AIRPORT", 0xccddcc);
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
        vis = new AircraftVisual(ac.priority);
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

  private updateDestMarkers(aircraft: AircraftSnapshot[]) {
    const activeIds = new Set(aircraft.map((a) => a.id));
    for (const ac of aircraft) {
      let marker = this.destMarkers.get(ac.id);
      if (!marker) {
        marker = makeDestMarker(PRIORITY_COLORS[ac.priority] ?? 0x88ccff);
        this.scene.add(marker);
        this.destMarkers.set(ac.id, marker);
      }
      marker.position.copy(toThree(ac.destination));
    }
    for (const [id, marker] of this.destMarkers) {
      if (!activeIds.has(id)) {
        this.scene.remove(marker);
        marker.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
          if (child instanceof THREE.Sprite) {
            (child.material as THREE.Material).dispose();
          }
        });
        this.destMarkers.delete(id);
      }
    }
  }

  private updateConflicts(aircraft: AircraftSnapshot[]) {
    this.conflictLines.forEach((l) => this.scene.remove(l));
    this.conflictLines = [];
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
        if (nb.state !== "UNRESPONSIVE" && nb.age < 5) continue;
        const radius = 150 + 40 * nb.age;
        staleIds.add(nb.id);
        let mesh = this.uncertainMeshes.get(nb.id);
        if (!mesh) {
          mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xff4444, opacity: 0.08, transparent: true }),
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

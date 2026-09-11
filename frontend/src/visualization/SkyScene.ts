/**
 * SkyScene — Three.js 3D visualization of the SkyMesh airspace.
 *
 * Renders aircraft markers, predicted trajectory vectors, conflict lines,
 * communication links, obstacles, uncertainty regions, and bounds grid.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SimSnapshot, AircraftSnapshot } from "../api/types";

const PRIORITY_COLORS = [0xaaddff, 0xffaa44, 0x44dd88, 0xffdd44, 0xff4444];
const COMM_LINE_COLOR = 0x336688;
const STALE_LINE_COLOR = 0x995533;
const CONFLICT_COLOR = 0xff2222;

// Position format: sim (x, y, z_alt) → THREE (x, z_alt, y)
function toThree(pos: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(pos[0], pos[2], pos[1]);
}

class AircraftVisual {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  velocityLine: THREE.Line;
  destinationLine: THREE.Line;
  trailPoints: THREE.Vector3[] = [];
  trailLine: THREE.Line;
  neighborLines: THREE.Line[] = [];
  conflictLines: THREE.Line[] = [];
  label: THREE.Sprite | null = null;

  constructor() {
    this.group = new THREE.Group();

    const bodyGeo = new THREE.ConeGeometry(120, 360, 6);
    bodyGeo.rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshPhongMaterial({ color: 0xaaddff });
    this.bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    this.bodyMesh.castShadow = true;
    this.group.add(this.bodyMesh);

    // Velocity predicted vector (dashed)
    const vLineGeo = new THREE.BufferGeometry();
    const vLineMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 200, gapSize: 150, opacity: 0.6, transparent: true });
    this.velocityLine = new THREE.Line(vLineGeo, vLineMat);
    this.group.add(this.velocityLine);

    // Destination line (thin)
    const dLineGeo = new THREE.BufferGeometry();
    const dLineMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.15, transparent: true });
    this.destinationLine = new THREE.Line(dLineGeo, dLineMat);
    this.group.add(this.destinationLine);

    // Trail
    const tLineGeo = new THREE.BufferGeometry();
    const tLineMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.3, transparent: true });
    this.trailLine = new THREE.Line(tLineGeo, tLineMat);
    this.group.add(this.trailLine);
  }

  update(ac: AircraftSnapshot) {
    const pos = toThree(ac.position);
    this.group.position.copy(pos);

    // heading rotation (cone points +Z by default in our setup)
    const heading = ac.heading;
    this.bodyMesh.rotation.set(0, -heading, 0);

    // color by priority
    const mat = this.bodyMesh.material as THREE.MeshPhongMaterial;
    mat.color.setHex(PRIORITY_COLORS[ac.priority] ?? 0xaaddff);
    if (ac.emergency) mat.emissive.setHex(0xff2222);
    else mat.emissive.setHex(0x000000);

    // velocity prediction line
    const v = ac.velocity;
    const speed = Math.hypot(v[0], v[1]);
    if (speed > 1) {
      const dir = new THREE.Vector3(v[0], v[2], v[1]).normalize();
      const predictDist = Math.min(speed * 15, 2500);
      const pts = [new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(predictDist)];
      this.velocityLine.geometry.dispose();
      this.velocityLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this.velocityLine.computeLineDistances();
      this.velocityLine.visible = true;
    } else {
      this.velocityLine.visible = false;
    }

    // destination line
    const dest = toThree(ac.destination);
    const destLocal = dest.clone().sub(pos);
    if (destLocal.length() > 100) {
      this.destinationLine.geometry.dispose();
      this.destinationLine.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        destLocal,
      ]);
      this.destinationLine.visible = true;
    } else {
      this.destinationLine.visible = false;
    }

    // trail
    this.trailPoints.push(pos.clone());
    if (this.trailPoints.length > 30) this.trailPoints.shift();
    if (this.trailPoints.length > 1) {
      // trail is in world coords, convert to local
      const local = this.trailPoints.map((p) => p.clone().sub(pos));
      this.trailLine.geometry.dispose();
      this.trailLine.geometry = new THREE.BufferGeometry().setFromPoints(local);
    }
  }

  reset() {
    this.trailPoints = [];
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

export class SkyScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  container: HTMLElement;

  aircraftMap: Map<string, AircraftVisual> = new Map();
  conflictLines: THREE.Line[] = [];
  neighborLines: THREE.Line[] = [];
  obstacleMeshes: THREE.Mesh[] = [];
  uncertainMeshes: Map<string, THREE.Mesh> = new Map();

  boundsGroup: THREE.Group;

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0a0a1a);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a0a1a, 0.000025);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 50, 100000);
    this.camera.position.set(5000, 8000, 15000);
    this.camera.lookAt(7500, 1500, 7500);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(7500, 1500, 7500);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 1000;
    this.controls.maxDistance = 40000;

    // lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(10000, 15000, 5000);
    this.scene.add(dir);
    const hemi = new THREE.HemisphereLight(0x8888ff, 0x444422, 0.3);
    this.scene.add(hemi);

    // grid
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
    this.updateBounds(snapshot.airspace.width, snapshot.airspace.depth, snapshot.airspace.floor, snapshot.airspace.ceiling);
    this.updateObstacles(snapshot.airspace.obstacles);
    this.updateAircraft(snapshot.aircraft);
    this.updateConflicts(snapshot.aircraft);
    this.updateNeighborLines(snapshot.aircraft);
    this.updateUncertainty(snapshot);
  }

  private updateBounds(width: number, depth: number, floor: number, ceiling: number) {
    if (this.boundsGroup.children.length > 0) return;
    const grid = new THREE.GridHelper(Math.max(width, depth), 30, 0x222244, 0x111133);
    grid.position.set(width / 2, floor, depth / 2);
    this.boundsGroup.add(grid);

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(width, ceiling - floor, depth));
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x334466, opacity: 0.3, transparent: true });
    const box = new THREE.LineSegments(edges, edgeMat);
    box.position.set(width / 2, (floor + ceiling) / 2, depth / 2);
    this.boundsGroup.add(box);
  }

  private updateObstacles(obstacles: { id: string; kind: string; center: [number, number, number]; radius: number; height: number }[]) {
    const existing = new Set(this.obstacleMeshes.map((m) => m.userData.id));
    const incoming = new Set(obstacles.map((o) => o.id));

    for (const obs of obstacles) {
      if (existing.has(obs.id)) continue;
      const geo = new THREE.CylinderGeometry(obs.radius, obs.radius, obs.height, 24);
      const mat = new THREE.MeshPhongMaterial({
        color: obs.kind === "NO_FLY" ? 0xff2222 : obs.kind === "STORM" ? 0x9944cc : 0xffaa00,
        opacity: 0.25,
        transparent: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const [cx, cy, cz] = obs.center;
      mesh.position.set(cx, cy, cz);
      mesh.userData.id = obs.id;
      this.scene.add(mesh);
      this.obstacleMeshes.push(mesh);
    }

    for (const mesh of [...this.obstacleMeshes]) {
      if (!incoming.has(mesh.userData.id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.obstacleMeshes = this.obstacleMeshes.filter((m) => m !== mesh);
      }
    }
  }

  private updateAircraft(aircraft: AircraftSnapshot[]) {
    const activeIds = new Set(aircraft.map((a) => a.id));

    for (const ac of aircraft) {
      let vis = this.aircraftMap.get(ac.id);
      if (!vis) {
        vis = new AircraftVisual();
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

    const drawn = new Set<string>();
    for (const ac of aircraft) {
      for (const otherId of ac.conflict_with) {
        const key = [ac.id, otherId].sort().join("|");
        if (drawn.has(key)) continue;
        drawn.add(key);
        const other = this.aircraftMap.get(otherId);
        if (!other) continue;
        const pts = [toThree(ac.position), other.group.position];
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: CONFLICT_COLOR, linewidth: 2, opacity: 0.8, transparent: true });
        const line = new THREE.Line(geo, mat);
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
        const geo = new THREE.BufferGeometry().setFromPoints([toThree(ac.position), other.group.position]);
        const mat = new THREE.LineBasicMaterial({ color, opacity: 0.2, transparent: true });
        const line = new THREE.Line(geo, mat);
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
          const geo = new THREE.SphereGeometry(radius, 16, 12);
          const mat = new THREE.MeshBasicMaterial({ color: 0xff4444, opacity: 0.08, transparent: true });
          mesh = new THREE.Mesh(geo, mat);
          this.scene.add(mesh);
          this.uncertainMeshes.set(nb.id, mesh);
        }
        const pos = this.aircraftMap.get(nb.id)?.group.position;
        if (pos) mesh.position.copy(pos);
        const oldGeo = mesh.geometry as THREE.SphereGeometry;
        if (Math.abs((oldGeo as unknown as { parameters: { radius: number } }).parameters.radius - radius) > 10) {
          mesh.geometry.dispose();
          mesh.geometry = new THREE.SphereGeometry(radius, 16, 12);
        }
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
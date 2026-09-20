// Generates public/models/Aircraft.glb offline (no network needed).
//
// Convention (must match `loadGlbModel` in SkyScene.ts):
//   nose -> +Z
//   wingspan -> +/-X
//   up      -> +Y
// So `rotation.y = heading` orients the plane nose-first with no bbox math.
//
// Run:  npm run gen:aircraft  (from the frontend directory)

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// GLTFExporter's binary path uses the browser FileReader; provide a shim so
// the script runs in plain Node (no DOM).
if (typeof FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    result = null;
    onloadend = null;
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        if (this.onloadend) this.onloadend();
      });
    }
  };
}

const OUT = fileURLToPath(new URL("../public/models/Aircraft.glb", import.meta.url));
mkdirSync(dirname(OUT), { recursive: true });

// One shared material so the runtime phase-tint (traverse -> m.color/emissive)
// recolours the whole airframe uniformly, like the procedural fallback.
const mat = new THREE.MeshPhongMaterial({ color: 0xd2d9de, shininess: 40 });

const plane = new THREE.Group();

// ── fuselage: lathe profile along +Y, then rotated so nose points +Z ──
const profile = [
  new THREE.Vector2(0.4, -172), // tail tip
  new THREE.Vector2(2.4, -168),
  new THREE.Vector2(5.6, -150),
  new THREE.Vector2(7.4, -100),
  new THREE.Vector2(7.6, 0),
  new THREE.Vector2(7.5, 110),
  new THREE.Vector2(7.2, 145),
  new THREE.Vector2(6.2, 160),
  new THREE.Vector2(3.6, 170),
  new THREE.Vector2(0.4, 172), // nose tip
];
const fuseGeo = new THREE.LatheGeometry(profile, 20);
fuseGeo.rotateX(-Math.PI / 2); // axis +Y -> +Z (nose lands at +Z)
const fuse = new THREE.Mesh(fuseGeo, mat);
fuse.position.y = -1;
plane.add(fuse);

// ── wings: swept planform (span X, chord Z), thin vertical thickness ──
const wingShape = new THREE.Shape();
wingShape.moveTo(-7, -8); // root leading edge
wingShape.lineTo(58, -30); // tip leading edge (swept back)
wingShape.lineTo(58, -18); // tip trailing edge
wingShape.lineTo(-7, 24); // root trailing edge (wide root chord)
const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 2.6, bevelEnabled: false });
wingGeo.rotateX(-Math.PI / 2); // planform in XZ, thickness along -Y
wingGeo.translate(0, -1.3, 0);
const wing = new THREE.Mesh(wingGeo, mat);
wing.position.y = -4;
plane.add(wing);

const leftWingGeo = wingGeo.clone();
leftWingGeo.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
const leftWing = new THREE.Mesh(leftWingGeo, mat);
leftWing.position.y = -4;
plane.add(leftWing);

// ── tailplane + fin ──
const tail = new THREE.Mesh(new THREE.BoxGeometry(26, 1.1, 9), mat);
tail.position.set(0, -2, -150);
plane.add(tail);

const fin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 11, 8), mat);
fin.position.set(0, 5, -150);
plane.add(fin);

// ── under-wing engine pods ──
const podProfile = [
  new THREE.Vector2(0.3, -30),
  new THREE.Vector2(1.2, -28),
  new THREE.Vector2(1.9, -20),
  new THREE.Vector2(1.9, 8),
  new THREE.Vector2(1.6, 12),
  new THREE.Vector2(0.8, 14),
  new THREE.Vector2(0.3, 15),
];
const podGeo = new THREE.LatheGeometry(podProfile, 16);
podGeo.rotateX(-Math.PI / 2);
podGeo.scale(0.95, 0.95, 1); // oval cross-section
for (const sx of [-13, 13]) {
  const pod = new THREE.Mesh(podGeo, mat);
  pod.position.set(sx, -6.2, -8);
  plane.add(pod);
}

plane.traverse((o) => {
  if (o instanceof THREE.Mesh) {
    o.castShadow = true;
    o.receiveShadow = true;
  }
});

const exporter = new GLTFExporter();
exporter.parse(
  plane,
  (result) => {
    writeFileSync(OUT, Buffer.from(result));
    console.log(`generated ${OUT} (${Buffer.from(result).byteLength.toLocaleString()} bytes)`);
  },
  (err) => {
    console.error("GLTF export failed:", err);
    process.exit(1);
  },
  { binary: true },
);
/**
 * terrainField — deterministic, everywhere-defined terrain height sampling.
 *
 * The backend serves one authoritative (finite) elevation grid over the
 * airspace. Beyond that grid the land eases into gentle, calm lowland that
 * rolls to the horizon. It deliberately does NOT re-run the full relief
 * recipe: doing so re-created 600-3000 m ridged mountain bands just past the
 * map rim (the ridged fBm "spines"), which rendered as a regular, artificial
 * border of parallel ripples around the world.
 *
 *   - `createUnifiedHeightField` exposes one height function for the whole
 *     plane: exact backend bilinear values inside the grid, easing into the
 *     lowland field across `RING_RAMP` metres outside its rim.
 *   - `buildStaticTerrainGeometry` snapshots that height function into one
 *     world-anchored structured grid (fine over the backend grid, coarsening
 *     beyond it) for display — built once and never re-anchored, so the
 *     rendered ground never changes as the camera moves. Its coarse outer
 *     lattice can optionally fade toward the scene haze colour with distance
 *     so it dissolves before its facets (or its far edge) can read on screen.
 *   - `createProceduralHeightField` remains exported for reference / reuse but
 *     is no longer part of the world: the ring is calm lowland by design.
 */

import * as THREE from "three";
import type { TerrainMeta } from "../api/types";

export interface HeightField {
  heightAt: (x: number, z: number) => number;
}

export interface StaticTerrainSpec {
  /** Lattice spacing inside the authoritative backend grid (m). */
  coreCell: number;
  /** Lattice spacing of the outer ring (m). A multiple of coreCell keeps the
   * lattice aligned so the tessellation coarsens without seams. */
  ringCell: number;
  /** How far the coarse ring extends beyond the backend grid bounds (m). */
  ringReach: number;
}

const ZMIN = 100.0;
const ZMAX = 4700.0;

/** Distance (metres) over which land outside the backend grid eases into calm
 * lowland. Long enough that the transition is invisible, short enough that the
 * lowland is fully established well before the coarse ring's outer edge. */
export const RING_RAMP = 30000;

function _smooth(t: number): number {
  return t * t * (3.0 - 2.0 * t);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Deterministic 2D integer hash → [0, 1). One (x, z) always maps to one value,
// so any two windows sampling the same lattice point agree exactly.
function hash2(ix: number, iz: number, seed: number): number {
  let h = (seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth value noise, continuous everywhere, defined at any scale.
function valueNoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = _smooth(x - ix);
  const fz = _smooth(z - iz);
  const v00 = hash2(ix, iz, seed);
  const v10 = hash2(ix + 1, iz, seed);
  const v01 = hash2(ix, iz + 1, seed);
  const v11 = hash2(ix + 1, iz + 1, seed);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fz;
}

// fBm / ridged value noise (octave lattice halving, matched to the backend
// `_noise_field`). Returns values in [0, 1].
function fbm(
  x: number,
  z: number,
  seed: number,
  scale0: number,
  octaves: number,
  ridged = false,
): number {
  let total = 0;
  let norm = 0;
  let amp = 1;
  let scale = scale0;
  for (let o = 0; o < octaves; o++) {
    let v = valueNoise2(x / scale, z / scale, (seed + o * 1013904223) | 0);
    if (ridged) v = (1 - Math.abs(2 * v - 1)) ** 2;
    total += amp * v;
    norm += amp;
    amp *= 0.5;
    scale *= 0.5;
  }
  return total / norm;
}

// Valley polyline (absolute metres), from the backend relief build.
const VALLEY_POLY: [number, number][] = [
  [40.0, 60.0],
  [60.0, 52.0],
  [80.0, 80.0],
  [100.0, 92.0],
  [120.0, 105.0],
].map(([x, y]) => [x * 1000.0, y * 1000.0]);

function valleyDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < VALLEY_POLY.length - 1; i++) {
    const [x1, y1] = VALLEY_POLY[i];
    const [x2, y2] = VALLEY_POLY[i + 1];
    const vx = x2 - x1;
    const vy = y2 - y1;
    const len2 = vx * vx + vy * vy;
    const t =
      len2 < 1e-9 ? 0 : clamp01(((x - x1) * vx + (z - y1) * vy) / len2);
    const px = x1 + vx * t;
    const py = y1 + vy * t;
    const d = Math.hypot(x - px, z - py);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Deterministic procedural elevation at any world point, in the backend's own
 * world frame (offsets measured from the airspace centre). Style-match, not
 * numpy-bit-exact: continuous + repeatable, which is all seamless tiling needs.
 */
export function createProceduralHeightField(
  cx: number,
  cy: number,
  seed = 1337,
): (x: number, z: number) => number {
  const baseSeed = seed ^ 0x5f5f;
  const s1 = seed ^ 0x1a1a;
  const s2 = seed ^ 0x2b2b;
  const s3 = seed ^ 0x3c3c;

  const spine = (
    lx: number,
    ly: number,
    angle: number,
    width: number,
    amp: number,
    alongScale: number,
    s: number,
  ): number => {
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const across = -lx * sn + ly * c;
    const along = lx * c + ly * sn;
    const band = Math.exp(-((across / width) ** 2) / 2);
    const rn = fbm(along, across, s, alongScale, 4, true);
    return band * amp * (0.28 + 0.72 * rn);
  };

  return (x: number, z: number): number => {
    const lx = x - cx;
    const ly = z - cy;

    // 1) Coastal plain with soft rolling relief.
    const base = 200.0 + 150.0 * (fbm(lx, ly, baseSeed, 5200.0, 4) - 0.5);

    // 2) Mountain massif: overlapping ridged spines rising to the NE.
    const mountains =
      spine(lx, ly, -0.65, 11000.0, 3600.0, 9000.0, s1) +
      spine(lx, ly, 0.6, 8000.0, 1800.0, 7000.0, s2) +
      spine(lx, ly, 1.75, 5500.0, 1000.0, 6000.0, s3);

    // 3) Valley system carved through the lowlands.
    const vdist = valleyDistance(x, z);
    const valley = 470.0 * Math.exp(-((vdist / 12000.0) ** 2));

    const h = base + mountains - valley;
    return Math.max(ZMIN, Math.min(ZMAX, h));
  };
}

/**
 * One height function for the whole world. Inside the authoritative grid the
 * backend bilinear value is returned exactly (physics/aircraft see the same
 * land). Outside its rim the value eases into a calm, deterministic lowland
 * field across `ramp` metres, so the world past the map recedes to gentle
 * rolling plains instead of re-raising fake mountain borders.
 */
export function createUnifiedHeightField(
  meta: TerrainMeta,
  grid: Float32Array,
  _cx: number,
  _cy: number,
  ramp = RING_RAMP,
): HeightField {
  const { x0, y0, cell, width, height } = meta;
  if (width < 2 || height < 2) {
    throw new Error(`[terrain] grid too small (${width}x${height}) — bilinear sampling needs 2x2`);
  }
  const x1 = x0 + (width - 1) * cell;
  const y1 = y0 + (height - 1) * cell;

  const bilinear = (sx: number, sy: number): number => {
    const fx = (sx - x0) / cell;
    const fy = (sy - y0) / cell;
    const xi = Math.max(0, Math.min(width - 2, Math.floor(fx)));
    const yi = Math.max(0, Math.min(height - 2, Math.floor(fy)));
    const tx = fx - xi;
    const ty = fy - yi;
    const a = grid[yi * width + xi];
    const b = grid[yi * width + xi + 1];
    const c = grid[(yi + 1) * width + xi];
    const d = grid[(yi + 1) * width + xi + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };

  // Deterministic, gentle rolling lowland beyond the grid rim: wide (~5 km)
  // wavelength, small amplitude, so the outer ring stays smooth and calm.
  const lowland = (sx: number, sy: number): number => {
    const n = fbm(sx, sy, 1337 ^ 0x0f0f, 5200, 4);
    return Math.max(ZMIN, Math.min(ZMAX, 130 + 120 * (n - 0.5)));
  };

  return {
    heightAt: (sx: number, sy: number): number => {
      const g = bilinear(sx, sy);
      const dxOut = Math.max(x0 - sx, sx - x1, 0);
      const dyOut = Math.max(y0 - sy, sy - y1, 0);
      const d = Math.hypot(dxOut, dyOut);
      if (d <= 0) return g;
      const t = ramp <= 0 ? 1 : _smooth(clamp01(d / ramp));
      const lo = lowland(sx, sy);
      return g + (lo - g) * t;
    },
  };
}

/**
 * One static, world-anchored heightfield mesh for the whole visible world.
 *
 * A structured grid whose columns/rows run: coarse ring (below the grid) at
 * `ringCell`, the authoritative backend grid at `coreCell`, then a coarse ring
 * again — one lattice, so the mesh is a single watertight surface with no
 * T-junctions or seams. Built once and never anchored to the camera, so the
 * tessellation (and the per-vertex relief colouring) is frozen: moving the
 * camera can no longer re-shape or re-texture the ground.
 *
 * Fills position/color/normal attributes in row batches, yielding to the main
 * thread between batches (`yieldToMain`), so the one-time build never freezes
 * the UI. Normals are analytic central differences of the height function (no
 * index sweep) using the local lattice spacing at each vertex.
 *
 * When `haze` is given, ring vertices (anything stepped at `ringCell`, i.e.
 * outside the backend grid) are additionally faded toward that haze colour in
 * proportion to their distance beyond the grid rim. The original relief colour
 * and the per-vertex fade factor are stored on `geo.userData.ringFade` so the
 * caller can re-aim the fade at the current sky/fog colour (e.g. on a day →
 * night switch) via `retargetTerrainRingFade`.
 */
export async function buildStaticTerrainGeometry(
  meta: TerrainMeta,
  heightAt: (x: number, z: number) => number,
  baseY: number,
  spec: StaticTerrainSpec,
  yieldToMain: () => Promise<void>,
  haze: { r: number; g: number; b: number } | null = null,
): Promise<THREE.BufferGeometry> {
  const { x0, y0, width, height } = meta;
  const cell = meta.cell;
  const x1 = x0 + (width - 1) * cell;
  const y1 = y0 + (height - 1) * cell;
  const core = Math.max(1, spec.coreCell);
  const ring = Math.max(core, spec.ringCell);
  const nRing = Math.max(1, Math.ceil(spec.ringReach / ring));

  // Ascending lattice coordinates: ring lows, core, ring highs.
  const xs: number[] = [];
  for (let k = nRing; k >= 1; k--) xs.push(x0 - k * ring);
  for (let i = 0; i < width; i++) xs.push(x0 + i * core);
  for (let k = 1; k <= nRing; k++) xs.push(x0 + (width - 1) * core + k * ring);
  const zs: number[] = [];
  for (let k = nRing; k >= 1; k--) zs.push(y0 - k * ring);
  for (let j = 0; j < height; j++) zs.push(y0 + j * core);
  for (let k = 1; k <= nRing; k++) zs.push(y0 + (height - 1) * core + k * ring);

  const cols = xs.length;
  const rows = zs.length;
  const n = cols * rows;

  // Local lattice spacing per column/row (used for the normal stencil).
  const colSp = new Float32Array(cols);
  for (let c = 0; c < cols; c++) colSp[c] = c < nRing || c >= nRing + width ? ring : core;
  const rowSp = new Float32Array(rows);
  for (let r = 0; r < rows; r++) rowSp[r] = r < nRing || r >= nRing + height ? ring : core;

  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);

  // Same relief colour recipe as the old per-window build: tan lowlands rising
  // to bright rock crests with a faint deterministic dapple.
  const rockLine = meta.zmin + 0.5 * (meta.zmax - meta.zmin);
  const rockSpan = Math.max(1, meta.zmax - rockLine);
  const low = { r: 0.88, g: 0.78, b: 0.58 };
  const high = { r: 0.94, g: 0.97, b: 1.0 };

  // Ring vertices only: vertex index + original relief colour + fade factor,
  // so the haze aim can be re-applied later without re-deriving relief colours.
  const ringStores: { indices: number[]; relief: number[]; fade: number[] } | null = haze
    ? { indices: [], relief: [], fade: [] }
    : null;

  const BATCH_ROWS = 48;
  for (let start = 0; start < rows; start += BATCH_ROWS) {
    const end = Math.min(start + BATCH_ROWS, rows);
    for (let r = start; r < end; r++) {
      const z = zs[r];
      const dz = rowSp[r];
      for (let c = 0; c < cols; c++) {
        const x = xs[c];
        const dx = colSp[c];
        const h = heightAt(x, z);
        const i = r * cols + c;
        const o = i * 3;
        positions[o] = x;
        positions[o + 1] = baseY + h;
        positions[o + 2] = z;

        const crest = clamp01((h - rockLine) / rockSpan);
        const vib = 0.05 * Math.sin(x * 0.0017 + z * 0.0009 + h * 0.002);
        const relR = low.r + (high.r - low.r) * crest + vib;
        const relG = low.g + (high.g - low.g) * crest + vib;
        const relB = low.b + (high.b - low.b) * crest + vib;
        colors[o] = relR;
        colors[o + 1] = relG;
        colors[o + 2] = relB;

        // Outer lattice: fade toward haze by distance beyond the grid rim.
        const inRing = c < nRing || c >= nRing + width || r < nRing || r >= nRing + height;
        if (inRing && ringStores) {
          const dxo = Math.max(x0 - x, x - x1, 0);
          const dyo = Math.max(y0 - z, z - y1, 0);
          const d = Math.hypot(dxo, dyo);
          const f = RING_RAMP > 0 ? _smooth(clamp01(d / RING_RAMP)) : 1;
          if (f > 0) {
            colors[o] = relR + (haze!.r - relR) * f;
            colors[o + 1] = relG + (haze!.g - relG) * f;
            colors[o + 2] = relB + (haze!.b - relB) * f;
            ringStores.indices.push(i);
            ringStores.relief.push(relR, relG, relB);
            ringStores.fade.push(f);
          }
        }

        const hxm = heightAt(x - dx, z);
        const hxp = heightAt(x + dx, z);
        const hzm = heightAt(x, z - dz);
        const hzp = heightAt(x, z + dz);
        const nx = -(hxp - hxm) / (2 * dx);
        const nz = -(hzp - hzm) / (2 * dz);
        const len = Math.hypot(nx, 1, nz) || 1;
        normals[o] = nx / len;
        normals[o + 1] = 1 / len;
        normals[o + 2] = nz / len;
      }
    }
    if (end < rows) await yieldToMain();
  }

  const indexCount = (rows - 1) * (cols - 1) * 6;
  const indices = n > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + cols;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  if (ringStores && ringStores.indices.length > 0) {
    geo.userData.ringFade = {
      indices: new Uint32Array(ringStores.indices),
      relief: new Float32Array(ringStores.relief),
      fade: new Float32Array(ringStores.fade),
    };
  }
  return geo;
}

/**
 * Re-aim the outer-ring haze fade at a new colour (e.g. the fog/sky colour
 * after a day → night switch). Only ring vertices are touched, reusing the
 * relief colours stored at build time, so the fade target can change without
 * re-sampling or re-tessellating anything.
 */
export function retargetTerrainRingFade(
  geo: THREE.BufferGeometry,
  haze: { r: number; g: number; b: number },
): void {
  const ring: { indices: Uint32Array; relief: Float32Array; fade: Float32Array } | undefined =
    geo.userData.ringFade;
  if (!ring) return;
  const colorAttr = geo.getAttribute("color") as THREE.BufferAttribute;
  const arr = colorAttr.array as Float32Array;
  const { indices, relief, fade } = ring;
  for (let k = 0; k < indices.length; k++) {
    const o = indices[k] * 3;
    const f = fade[k];
    const rl = k * 3;
    arr[o] = relief[rl] + (haze.r - relief[rl]) * f;
    arr[o + 1] = relief[rl + 1] + (haze.g - relief[rl + 1]) * f;
    arr[o + 2] = relief[rl + 2] + (haze.b - relief[rl + 2]) * f;
  }
  colorAttr.needsUpdate = true;
}
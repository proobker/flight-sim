/* SkyMesh type definitions matching the backend snapshot schema. */

export interface Obstacle {
  id: string;
  kind: string;
  center: [number, number, number];
  radius: number;
  height: number;
  active: boolean;
}

export interface Airport {
  id: string;
  name: string;
  center: [number, number, number];
  radius: number;
  closed: boolean;
}

export interface AirspaceSnapshot {
  width: number;
  depth: number;
  floor: number;
  ceiling: number;
  airports: Airport[];
  obstacles: Obstacle[];
}

export interface NeighborInfo {
  id: string;
  age: number;
  state: string;
  confidence: number;
  distance: number | null;
}

export interface AircraftSnapshot {
  id: string;
  position: [number, number, number];
  velocity: [number, number, number];
  heading: number;
  speed: number;
  vertical_rate: number;
  destination: [number, number, number];
  priority: number;
  emergency: boolean;
  active: boolean;
  origin_aid: string | null;
  dest_aid: string | null;
  state: "cruise" | "landing" | "held";
  progress: number;
  leg_distance: number;
  trajectory_version: number;
  waypoint: [number, number, number] | null;
  plan: [[number, number, number], number, number] | null;
  maneuvering: boolean;
  landing: boolean;
  distance: number;
  fuel: number;
  neighbors: NeighborInfo[];
  conflict_with: string[];
}

export interface SimSnapshot {
  time: number;
  config: { multicast_group: string; multicast_port: number; comm_range: number };
  airspace: AirspaceSnapshot;
  aircraft_count: number;
  total_spawned: number;
  active: number;
  network_nodes_total: number;
  active_conflicts: number;
  collisions: number;
  near_misses: number;
  min_separation: number | null;
  conflicts_detected: number;
  conflicts_resolved: number;
  avg_resolution_ms: number;
  nodes_failed: number;
  partition_events: number;
  aircraft: AircraftSnapshot[];
}
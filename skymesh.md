# SkyMesh — Decentralized Autonomous Airspace
## Failure-Resilient Peer-to-Peer Aircraft Conflict Resolution Simulator

> **Tagline:** What happens when aircraft have to coordinate without a central ATC server — and the network starts failing?

---

## 1. Executive Summary

SkyMesh is a real-time simulation platform for **decentralized autonomous airspace coordination**.

Instead of relying on one central air-traffic-control server to know the position and intentions of every aircraft, each simulated aircraft acts as an independent network node. Nearby aircraft exchange local state and planned trajectories, detect potential conflicts in four dimensions (X, Y, Z, Time), negotiate alternative maneuvers, and independently converge on safe trajectories.

The project is deliberately designed as a **failure-injection laboratory** rather than a claim that decentralized ATC is a new concept.

Existing aviation research has explored decentralized aircraft conflict resolution, collaborative trajectory negotiation, and unmanned-traffic-management architectures. SkyMesh's hackathon contribution is a practical, interactive simulation that makes these concepts demonstrable and measurable, especially under failures such as:

- Aircraft/node failures
- Packet loss
- Communication latency
- Network partitions
- Stale aircraft state
- High aircraft density
- Simultaneous conflicts
- Uncertain trajectories

The central demo is simple:

> Spawn a busy airspace, let aircraft coordinate themselves, then deliberately break the system and watch it recover.

---

# 2. The Problem

Traditional air-traffic management relies heavily on centralized infrastructure, communication services, and shared coordination mechanisms.

As the number of autonomous drones, air taxis, cargo aircraft, and other autonomous vehicles increases, coordination becomes increasingly difficult.

A centralized simulator might look like:

```text
                   CENTRAL ATC
                       |
       ┌───────────────┼───────────────┐
       ↓               ↓               ↓
     Plane A         Plane B         Plane C
       ↓               ↓               ↓
     Plane D         Plane E         Plane F
```

Every aircraft reports to a central authority.

SkyMesh explores a different architecture:

```text
             Plane A ←→ Plane B
                ↕          ↕
             Plane C ←→ Plane D
                ↕          ↕
             Plane E ←→ Plane F
```

Aircraft communicate locally and make decisions using locally available information.

The question is:

> **Can a distributed airspace remain safe and recover quickly when aircraft and communication infrastructure fail?**

---

# 3. Important Scope / Novelty Disclaimer

SkyMesh should **not** be presented as:

> "We invented decentralized ATC."

That claim would be incorrect.

Decentralized aircraft conflict resolution has been researched for many years, including approaches where aircraft exchange information and negotiate trajectory changes.

SkyMesh instead presents itself as:

> **A real-time experimental simulation and benchmarking environment for decentralized autonomous airspace coordination under failures.**

This distinction protects the project from criticism while giving it a legitimate technical contribution.

The project can also explicitly compare:

1. Centralized planning
2. Decentralized local negotiation
3. Different conflict-resolution algorithms
4. Different failure conditions

The result is an engineering experiment rather than a novelty claim.

---

# 4. Core Concept

Each aircraft is an independent simulated node.

Every aircraft maintains:

```text
Aircraft State
├── ID
├── Position
├── Velocity
├── Acceleration
├── Heading
├── Altitude
├── Destination
├── Current trajectory
├── Planned trajectory
├── Fuel / energy estimate
├── Priority
└── Communication state
```

Aircraft periodically broadcast their local state to nearby peers.

Each aircraft maintains a local view:

```text
                  LOCAL WORLD MODEL

             ┌─────────────────────┐
             │      Aircraft A     │
             │                     │
             │ Known neighbors:    │
             │ B                   │
             │ C                   │
             │ D                   │
             └─────────────────────┘
```

It does not need the complete global state.

---

# 5. High-Level Architecture

```text
                    ┌──────────────────────┐
                    │   Simulation Engine  │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ↓                ↓                ↓
        Physics Engine     Network Engine    Event Engine
              │                │                │
              └────────────────┼────────────────┘
                               ↓
                     ┌──────────────────┐
                     │ Aircraft Nodes   │
                     └────────┬─────────┘
                              │
          ┌───────────────────┼────────────────────┐
          ↓                   ↓                    ↓
      Aircraft A          Aircraft B           Aircraft C
          ↕                   ↕                    ↕
      Local state         Local state          Local state
      prediction          prediction           prediction
          ↕                   ↕                    ↕
      Conflict             Conflict              Conflict
      resolver             resolver              resolver
          ↕                   ↕                    ↕
      Trajectory           Trajectory            Trajectory
      planner              planner               planner
```

---

# 6. Aircraft-to-Aircraft Communication

For a hackathon simulation, communication can be implemented using **UDP**.

Why UDP?

- Low overhead
- Naturally models unreliable communication
- Easy to introduce packet loss
- Easy to introduce latency
- Fits periodic state broadcasting
- Makes network failure experiments straightforward

A WebSocket implementation is also possible if the simulator is browser-based.

---

## 6.1 State Broadcast

Every aircraft periodically broadcasts something similar to:

```json
{
  "id": "A17",
  "timestamp": 18234.42,
  "position": [1020.5, 2300.1, 5000],
  "velocity": [250, 30, 0],
  "heading": 7.2,
  "destination": [12000, 9000, 5000],
  "priority": 1,
  "trajectory_version": 42
}
```

The exact protocol does not need to copy any real aviation protocol.

It is a simulation protocol.

---

# 7. Neighbor Discovery

Aircraft only need to care about aircraft within a relevant communication / safety range.

Example:

```text
             Communication range

                  .--------.
              .-'            '-.
            .'                  '.
           /         A            \
          |                        |
           \                      /
            '.                  .'
              '-.            .-'
                  '--------'
```

Aircraft outside this region may not be relevant to the immediate conflict.

Each node maintains a neighbor table:

```python
neighbors = {
    "B04": {
        "last_seen": 18234.1,
        "position": [...],
        "velocity": [...],
        "trajectory": [...],
        "confidence": 0.94
    }
}
```

A node that has not sent an update for a configurable amount of time becomes:

```text
ACTIVE
   ↓
STALE
   ↓
UNRESPONSIVE
```

---

# 8. The 4D Conflict Problem

A collision is not simply:

> "Two aircraft are close."

Two aircraft may cross the same physical location at different times.

Therefore SkyMesh considers:

```text
X
Y
Z
TIME
```

Example:

```text
                 A
                 \
                  \
                   X  ← conflict point
                  /
                 /
                B
```

If A reaches the point at:

```text
T = 25.2 s
```

and B reaches it at:

```text
T = 25.4 s
```

there is a conflict.

If B reaches it at:

```text
T = 60 s
```

there may be no conflict.

---

# 9. Safety Separation

Define minimum separation thresholds.

For example:

```text
horizontal separation >= H
vertical separation   >= V
```

A simplified conflict condition could be:

```python
distance(A(t), B(t)) < safety_radius
```

for any relevant time `t`.

A more advanced implementation can use an ellipsoidal safety region:

```text
        vertical
           ↑
           |
       .---+---.
     .'    |    '.
    /      |      \
   |-------A-------| → horizontal
    \      |      /
     '.    |    .'
       '---+---'
```

---

# 10. Trajectory Prediction

For the MVP, trajectories can be generated from:

```text
position
velocity
heading
acceleration
```

A simplified prediction:

```python
future_position = position + velocity * dt
```

For more advanced behavior, include acceleration and turning rate.

Each aircraft can maintain a trajectory consisting of time-stamped points:

```text
[
    (x1, y1, z1, t1),
    (x2, y2, z2, t2),
    (x3, y3, z3, t3),
    ...
]
```

---

# 11. Conflict Detection Pipeline

Every aircraft repeatedly executes:

```text
RECEIVE NEIGHBOR STATE
        ↓
UPDATE LOCAL WORLD MODEL
        ↓
PREDICT TRAJECTORIES
        ↓
CHECK 4D SEPARATION
        ↓
NO CONFLICT?
     /       \
   YES        NO
   ↓           ↓
CONTINUE    GENERATE
            MANEUVERS
```

---

# 12. Candidate Maneuvers

When a conflict occurs, an aircraft generates possible alternatives.

For example:

```text
Current trajectory
       |
       +---- Straight
       |
       +---- Turn left 10°
       |
       +---- Turn right 10°
       |
       +---- Climb
       |
       +---- Descend
       |
       +---- Slow down
       |
       +---- Speed up
```

Each candidate is simulated forward.

Unsafe candidates are discarded.

---

# 13. Maneuver Cost

Each safe trajectory receives a cost.

Example:

```text
cost =
    trajectory_deviation
  + fuel_penalty
  + delay_penalty
  + maneuver_complexity
  + risk_penalty
```

Example:

```text
Candidate             Cost

Straight               INVALID
Turn left 10°          17.3
Turn right 10°         31.8
Climb                   24.1
Slow down               19.7
```

The aircraft chooses:

```text
Turn left 10°
```

---

# 14. Distributed Negotiation

This is the core of SkyMesh.

Suppose A and B detect a conflict.

A generates:

```text
Proposal A:
"Turn left 10°"
```

B generates:

```text
Proposal B:
"Turn right 15°"
```

They exchange proposals.

Each evaluates:

```text
Safety
+
Cost
+
Priority
+
Impact on other aircraft
```

They need to converge on a consistent decision.

---

# 15. Deterministic Conflict Resolution

A simple deterministic rule can prevent endless disagreement.

For example:

```text
1. Safety
2. Emergency / priority
3. Lowest trajectory cost
4. Lowest predicted delay
5. Lowest trajectory deviation
6. Aircraft ID as final deterministic tie-breaker
```

Example:

```text
A proposal:
cost = 17.3

B proposal:
cost = 31.8

17.3 < 31.8

→ A's maneuver wins
```

The final tie-breaker is useful because every node can independently reach the same result.

---

# 16. Why Not Automatically Use Raft/Paxos?

Raft and Paxos are useful distributed-consensus algorithms, but a technically knowledgeable judge may ask:

> "Why does aircraft conflict resolution need a leader?"

Aircraft do not necessarily need to elect a permanent leader simply to avoid each other.

Therefore the project should treat consensus as an **experimental option**, not a mandatory architecture.

Possible modes:

```text
MODE 1
Centralized planner

MODE 2
Pairwise negotiation

MODE 3
Multi-aircraft distributed negotiation

MODE 4
Leader-based coordination

MODE 5
Consensus-based experiment
```

This makes the project more technically defensible.

---

# 17. Local vs Global Knowledge

The system intentionally limits information.

Centralized:

```text
             GLOBAL STATE
                  |
     ┌────────────┼────────────┐
     ↓            ↓            ↓
     A            B            C
```

Decentralized:

```text
A knows B
B knows A,C
C knows B,D
D knows C
```

This allows experiments on:

> How much global information is actually necessary?

---

# 18. Aircraft Failure Simulation

One of the main demo features.

User clicks:

```text
[KILL AIRCRAFT A17]
```

The simulator stops A17's network participation.

Other aircraft detect:

```text
No packet received
       ↓
State becomes stale
       ↓
Aircraft becomes unresponsive
       ↓
Last known trajectory retained
       ↓
Uncertainty increases
       ↓
Neighbors recalculate
```

Do not simply delete the aircraft.

Treat it as an **uncertain moving object**.

---

# 19. Uncertainty Model

If A17 stops communicating:

```text
T = 0
    ●

T = 5s
    ◯

T = 10s
    ◯
      ◯

T = 20s
    large uncertainty region
```

The longer the node is silent, the less confidence other aircraft have in its position.

A simple model:

```python
uncertainty = base_uncertainty + velocity_uncertainty * time_since_update
```

The aircraft must avoid the uncertainty region.

---

# 20. Communication Failure

The simulator should allow:

```text
Packet loss:       0–100%
Latency:           0–5000 ms
Jitter:            configurable
Bandwidth:         configurable
```

Example:

```text
Normal:

A ←→ B ←→ C ←→ D


After network degradation:

A -x- B ←→ C -x- D
```

This tests whether the system can operate with incomplete information.

---

# 21. Network Partition

A particularly strong demo.

Split the airspace into two network partitions:

```text
              NETWORK PARTITION

        A ←→ B          C ←→ D
        ↕                ↕
        E                F
```

Group 1 cannot communicate with Group 2.

Each group continues operating with local knowledge.

Then restore communication:

```text
A ←→ B ←→ C ←→ D
```

The system must reconcile its local state.

This is where distributed-systems behavior becomes genuinely interesting.

---

# 22. Simultaneous Conflicts

Do not only demonstrate one pair.

Create:

```text
A ──────→ X ←────── B

C ──────→ Y ←────── D

E ──────→ Z ←────── F
```

Now multiple negotiations occur simultaneously.

The challenge is that solving one conflict can create another.

Therefore every trajectory change must trigger a new global-local conflict check.

---

# 23. Cascading Conflict Example

```text
A conflicts with B

A changes trajectory

        ↓

A now conflicts with C

        ↓

A/C negotiate

        ↓

C changes trajectory

        ↓

C conflicts with D

        ↓

D/C negotiate
```

This creates a chain reaction.

A good implementation should resolve the chain without producing oscillating behavior.

---

# 24. Oscillation Prevention

A naive system could do:

```text
A moves left
B moves right

B moves left
A moves right

A moves left
B moves right
...
```

This is undesirable.

Solutions include:

- Trajectory commitment windows
- Hysteresis
- Minimum maneuver duration
- Proposal IDs
- Trajectory versions
- Cooldowns
- Deterministic tie-breaking

Example:

```text
Once maneuver accepted:
commit for 3 seconds
```

---

# 25. Emergency Priority

Not all aircraft should have equal priority.

Possible priority classes:

```text
0 = Normal
1 = Cargo
2 = Passenger
3 = Medical
4 = Emergency
```

An emergency aircraft could receive a lower maneuver cost for maintaining its route.

Example:

```text
Emergency aircraft:
cost of deviation × 0.4
```

This allows experiments involving competing objectives.

---

# 26. Dynamic Airspace

The environment should change during simulation.

Possible events:

```text
Storm appears
Runway closes
No-fly zone activates
Navigation beacon fails
Communication tower fails
Aircraft loses engine
Emergency aircraft enters
Traffic density increases
```

The aircraft must react to changes.

---

# 27. Airspace Obstacles

Represent restricted areas as geometric regions:

```text
        ┌──────────────┐
        │   NO-FLY     │
        │     ZONE     │
        └──────────────┘
```

Aircraft must route around them.

Possible obstacles:

- Airports
- Military zones
- Storm cells
- Mountains
- Temporary restrictions
- Emergency zones

---

# 28. Routing

The simulator can use different algorithms.

### MVP

Waypoint-based trajectory generation.

### Intermediate

A* on a 3D/4D discretized grid.

### Advanced

RRT / RRT*

### Advanced optimization

Model Predictive Control (MPC).

### Swarm-style alternatives

Velocity Obstacles / ORCA-inspired collision avoidance.

The architecture should allow multiple planners to be plugged in.

---

# 29. Centralized Baseline

To make the project scientifically useful, implement a centralized baseline.

```text
                 CENTRAL PLANNER
                       |
       ┌───────────────┼───────────────┐
       ↓               ↓               ↓
       A               B               C
```

Then compare against:

```text
             DECENTRALIZED

       A ←→ B ←→ C ←→ D
```

This gives judges a concrete comparison.

---

# 30. Metrics

Do not rely only on a visual demo.

Measure:

### Safety

- Number of conflicts
- Minimum separation
- Number of collisions
- Near misses

### Performance

- Conflict-resolution time
- Average planning latency
- CPU usage
- Simulation tick rate

### Network

- Messages/second
- Bytes/second
- Packet loss
- Average latency
- Number of stale states

### Efficiency

- Average trajectory deviation
- Fuel/energy estimate
- Delay
- Distance traveled

### Resilience

- Recovery time after node failure
- Recovery time after network partition
- Percentage of aircraft successfully rerouted
- Number of cascading conflicts

---

# 31. Example Dashboard

```text
╔════════════════════════════════════════════╗
║              SKYMESH LIVE                  ║
╠════════════════════════════════════════════╣
║ Aircraft                 147                ║
║ Active Conflicts           3                ║
║ Resolved Conflicts       218                ║
║ Network Nodes            147/150            ║
║ Packet Loss              3.7%               ║
║ Avg Resolution           84 ms              ║
║ Minimum Separation       1.14 km             ║
║ Collisions                 0                ║
║ Network Partitions         1                ║
╚════════════════════════════════════════════╝
```

---

# 32. Failure Injection Panel

Create a control panel:

```text
FAILURE INJECTION

[ Kill Random Aircraft ]

[ Kill Selected Aircraft ]

[ Partition Network ]

[ Increase Packet Loss ]

[ Add Latency ]

[ Disable Communication Sector ]

[ Spawn Emergency Aircraft ]

[ Create Storm ]

[ Close Airport ]

[ Increase Traffic ]
```

This is one of the strongest parts of the presentation.

---

# 33. Visualization

The simulator should show:

- Aircraft
- Current trajectory
- Predicted trajectory
- Safety radius
- Conflict points
- Communication links
- Network partitions
- Uncertainty regions
- Airports
- No-fly zones

Example:

```text
              ✈ A
               \
                \
                 \     predicted
                  \      path
                   X
                  / \
                 /   \
             ✈ B     ✈ C
```

Communication links can be visualized as lines between nearby nodes.

---

# 34. Recommended Technology Stack

## Option A — Fastest Hackathon Build

Frontend:

```text
React
TypeScript
Three.js
```

Backend/simulation:

```text
Python
FastAPI
asyncio
```

Communication:

```text
WebSockets / UDP
```

Visualization:

```text
Three.js
```

---

## Option B — Python-heavy

```text
Python
Pygame / PyOpenGL
asyncio
FastAPI
NumPy
```

This is simpler if the team is stronger in Python.

---

## Option C — High-performance

```text
C++
WebSocket/UDP
OpenGL
React dashboard
```

Probably unnecessary for a short hackathon.

---

# 35. Recommended MVP

Do NOT attempt the entire vision during the hackathon.

Build this:

```text
100 aircraft
      ↓
local peer communication
      ↓
trajectory broadcasting
      ↓
4D conflict detection
      ↓
candidate maneuvers
      ↓
distributed negotiation
      ↓
real-time rerouting
      ↓
aircraft failure
      ↓
recovery
```

If time remains:

```text
packet loss
network partition
uncertainty
emergency priority
centralized comparison
metrics
```

---

# 36. 16-Hour Hackathon Plan

## Hour 0–2 — Simulation Core

Implement:

- 2D/3D coordinates
- Aircraft objects
- Velocity
- Destination
- Basic movement

Goal:

```text
100 aircraft moving simultaneously
```

---

## Hour 2–4 — Networking

Implement:

- Node IDs
- State broadcast
- Neighbor discovery
- Local state tables

Goal:

```text
A knows B
B knows A
```

---

## Hour 4–6 — Conflict Detection

Implement:

- Future trajectory prediction
- Minimum separation
- Conflict detection

Goal:

```text
CONFLICT DETECTED
```

---

## Hour 6–9 — Resolution

Implement:

- Candidate trajectories
- Safety filtering
- Cost function
- Proposal exchange
- Deterministic resolution

Goal:

```text
Conflict → Negotiation → New path
```

---

## Hour 9–11 — Failure Injection

Implement:

- Kill aircraft
- Packet loss
- Latency
- Network partition

Goal:

```text
Break system → system recovers
```

---

## Hour 11–14 — Visualization

Add:

- 3D map
- Trajectory lines
- Conflict indicators
- Communication links
- Dashboard

---

## Hour 14–16 — Demo + Metrics

Prepare:

- Normal scenario
- High-density scenario
- Aircraft failure
- Network partition
- Centralized vs decentralized comparison

---

# 37. Demo Scenario

The ideal presentation:

### Step 1

Start:

```text
50 aircraft
```

Everything is normal.

### Step 2

Increase traffic:

```text
50 → 150 aircraft
```

Conflicts begin appearing.

### Step 3

Show automatic negotiation.

```text
CONFLICT A17 ↔ B04

Proposal:
A17 → LEFT 8°

Accepted.

Conflict resolved: 71 ms
```

### Step 4

Say:

> "Now let's break it."

Kill 20 aircraft.

### Step 5

Show:

```text
20 NODES FAILED

Network adapting...
```

Remaining aircraft reroute.

### Step 6

Partition the network.

```text
NETWORK PARTITION DETECTED
```

### Step 7

Reconnect it.

```text
NETWORK RESTORED
STATE RECONCILIATION
```

### Step 8

Show metrics.

```text
Collisions: 0
Recovery time: 1.42 s
```

That is the moment to explain the architecture.

---

# 38. Example Internal Node Loop

Conceptually:

```python
while aircraft.active:

    receive_messages()

    update_neighbor_states()

    predict_local_trajectory()

    conflicts = detect_conflicts()

    if conflicts:

        candidates = generate_maneuvers()

        safe = filter_unsafe(candidates)

        proposal = select_best(safe)

        negotiate(proposal)

        if agreement_reached():
            commit_trajectory()

    execute_motion()

    broadcast_state()
```

This is the heart of the simulator.

---

# 39. Network Message Types

Keep the protocol small.

```text
HELLO
STATE_UPDATE
TRAJECTORY_PROPOSAL
TRAJECTORY_ACCEPT
TRAJECTORY_REJECT
CONFLICT_ALERT
TRAJECTORY_COMMIT
HEARTBEAT
EMERGENCY
```

Example:

```json
{
  "type": "CONFLICT_ALERT",
  "sender": "A17",
  "target": "B04",
  "time_to_conflict": 8.2,
  "predicted_distance": 430
}
```

---

# 40. Versioning

Every trajectory should have a version.

```text
A17 trajectory v41
A17 trajectory v42
A17 trajectory v43
```

This prevents nodes from applying stale decisions.

A proposal can contain:

```json
{
  "aircraft": "A17",
  "trajectory_version": 43,
  "proposal_id": "A17-43-882",
  "expires_at": 18242.1
}
```

---

# 41. Security — Optional Advanced Feature

If time permits, simulate malicious nodes.

For example:

```text
Aircraft A:
"MY POSITION = X"

Actual position:
Y
```

This creates a false-data problem.

Possible defenses:

- Neighbor consistency checks
- Reputation scores
- Cross-validation
- Signed messages
- Outlier detection

Do not attempt real aviation security implementation during the hackathon; keep it explicitly simulated.

---

# 42. Important Real-World Limitation

SkyMesh is a simulation.

It must not be presented as software suitable for controlling real aircraft.

Real aviation systems involve:

- Certification
- Safety assurance
- Redundant navigation
- Air-ground infrastructure
- Regulatory requirements
- Formal verification
- Human factors
- Communication standards
- Fail-safe procedures
- Extensive testing

The hackathon project demonstrates the **algorithmic and distributed-systems concept**, not operational aircraft control.

---

# 43. Research / Technical Foundation

The project can cite existing work on:

- Decentralized aircraft conflict resolution
- Negotiated trajectory planning
- Unmanned Traffic Management (UTM)
- Advanced Air Mobility
- Distributed multi-agent systems
- Collision avoidance
- Distributed consensus
- Fault-tolerant distributed systems

A good presentation phrase is:

> "The underlying problem has been studied in aviation research. Our project turns those ideas into an interactive failure-injection simulation and benchmarking environment."

This is honest and defensible.

---

# 44. Possible Project Names

### SkyMesh
**Decentralized Autonomous Airspace**

### AirMesh
**Peer-to-Peer Air Traffic Coordination**

### AeroMesh
**Distributed Aircraft Conflict Resolution**

### SkySync
**Collaborative Autonomous Airspace**

### FlightMesh
**Fault-Tolerant Autonomous Airspace**

### AirWeave
**Distributed Coordination for Autonomous Flight**

### SkyGrid
**Decentralized Airspace Intelligence**

Recommended:

# SkyMesh

It is short, memorable, and communicates the networking aspect.

---

# 45. Tagline Options

> **Break the network. Keep the sky safe.**

> **No tower. No central server. Just coordination.**

> **Autonomous aircraft. Distributed decisions.**

> **What happens when ATC disappears?**

The strongest hackathon tagline:

# **Break the network. Keep the sky safe.**

---

# 46. Judge Questions You Should Expect

## "Is this actually novel?"

Answer:

> "The underlying concept of decentralized aircraft conflict resolution has been researched before. We're not claiming to invent that field. Our contribution is a real-time simulation and failure-injection environment that lets us experimentally compare decentralized coordination under node failures, packet loss, partitions, and changing traffic."

---

## "Why decentralized?"

Answer:

> "A decentralized architecture removes dependence on a single coordination point and lets us study resilience when infrastructure or communication links fail."

---

## "Why not just use a central server?"

Answer:

> "For normal operation, a centralized system can be simpler. Our experiment asks what happens when that central coordination layer becomes unavailable or unreliable."

---

## "Why don't you use Raft?"

Answer:

> "We don't assume leader-based consensus is necessary for every conflict. We use direct negotiation as the baseline and treat consensus mechanisms as an experimental comparison."

This is a much stronger answer than claiming Raft is inherently required.

---

## "How do aircraft avoid oscillation?"

Answer:

> "We use trajectory versions, proposal IDs, deterministic tie-breaking, commitment windows, and maneuver cooldowns."

---

## "What happens when a plane stops communicating?"

Answer:

> "We don't simply remove it. Other aircraft retain its last known state, increase trajectory uncertainty over time, and treat its predicted region as a potential obstacle."

---

# 47. What Makes This a Strong Hackathon Project?

The project combines several difficult areas:

```text
Distributed Systems
        +
Graph Theory
        +
Geometry
        +
Optimization
        +
Networking
        +
Simulation
        +
Fault Tolerance
        +
Visualization
```

Most importantly, these aren't artificial additions.

Each component exists because it solves a real problem in the simulation.

---

# 48. What NOT to Build

Avoid spending the hackathon on:

- Real aircraft APIs
- Real aviation certification
- Actual aircraft control
- Extremely accurate aerodynamics
- Full global airspace
- Perfect physics
- Massive distributed deployment
- Building a production networking protocol
- Training a huge AI model

The objective is:

> **A convincing experimental simulator, not a certified aviation product.**

---

# 49. The Core MVP in One Diagram

```text
                 ┌─────────────────┐
                 │   AIRSPACE      │
                 │   SIMULATOR     │
                 └────────┬────────┘
                          │
          ┌───────────────┼────────────────┐
          ↓               ↓                ↓
       Aircraft        Network          Failures
          │               │                │
          ↓               ↓                ↓
      Position        P2P messages      Kill node
      Velocity        Packet loss       Partition
      Trajectory      Latency           Storm
          │               │
          └───────┬───────┘
                  ↓
          4D CONFLICT DETECTOR
                  ↓
          CANDIDATE MANEUVERS
                  ↓
          DISTRIBUTED NEGOTIATION
                  ↓
          SAFE TRAJECTORY
                  ↓
             EXECUTION
                  ↓
             NEW STATE
                  │
                  └──────────→ repeat
```

---

# 50. Final Project Definition

## SkyMesh

> **SkyMesh is a real-time simulation and benchmarking platform for decentralized autonomous airspace coordination. Each aircraft acts as an independent peer that exchanges local state, predicts 4D trajectory conflicts, negotiates maneuvers, and adapts to failures without relying on a central controller. The simulator deliberately injects aircraft failures, packet loss, communication latency, network partitions, and dynamic hazards to measure the resilience and performance of decentralized coordination algorithms.**

The strongest demo is not simply:

> "Look, aircraft avoid each other."

It is:

> **"There is no central controller. Now I'm going to kill 20% of the aircraft, cut the network in half, introduce packet loss, and see whether the remaining system can keep the airspace safe."**

That is the core identity of SkyMesh.

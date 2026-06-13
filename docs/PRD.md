# Raft — Consensus, Visualized

**Product Requirements Document**

A browser-based, interactive visualization of the Raft consensus algorithm. It
simulates a fictional replicated key-value store (à la etcd) but the product is
not the store — it is Raft itself: leader election, the immutable replicated
log, message passing between nodes, commitment, and recovery from failure, all
rendered as a living, scrubbable, tunable scene.

---

## 1. Goals & Non-Goals

### Goals

- **Teach Raft by watching it.** Make consensus legible: every election,
  vote, heartbeat, append, commit, and crash is visible and narrated.
- **Make time a first-class control.** Pause, slow down, speed up, scrub
  backward, and resume — losslessly.
- **Let the learner experiment.** Add/remove/crash/restart nodes, write keys,
  and turn dials (network latency, packet loss, election timing) to see how the
  protocol responds, including how to _break_ it.
- **Be beautiful.** A polished, distinctive scene that rewards watching, not a
  utilitarian diagram.
- **Keep the algorithm honest and reusable.** The Raft implementation is
  written from scratch (no consensus libraries) and lives as a self-contained,
  dependency-free module that could be lifted out and embedded elsewhere.

### Non-Goals

- **Not a production consensus library.** Correctness and clarity over
  performance; no persistence, no real networking, no disk model.
- **Not a faithful etcd/Redis clone.** The KV store is a teaching prop.
- **No log compaction / snapshot installation** (Raft §7) and **no joint-
  consensus membership** (§6) — membership changes are modeled out-of-band (see
  §4.4). These are documented simplifications, not omissions to hide.

---

## 2. Personas

- **The learner** — an engineer who has read about Raft and wants intuition.
  Default experience must be calm, watchable, and self-explanatory.
- **The tinkerer** — wants to stress the protocol: partition it, drop packets,
  shrink the election timeout until it livelocks, and see why the paper's
  guidance exists.
- **The reuser** — a developer who wants the `raft-core` module for their own
  project and expects it to be clean, typed, and free of UI/runtime coupling.

---

## 3. Architecture Overview

Four layers, strictly separated, each independently testable:

```
src/raft/   — the consensus algorithm (pure, sans-I/O, dependency-free)
src/sim/    — discrete-event simulator + timeline recorder + autopilot
src/viz/    — Three.js scene (nodes, message comets, effects, bloom)
src/ui/     — DOM HUD (controls, panels, scrubber, inspector, dials)
src/app.ts  — playback controller bridging sim-time and wall-time
```

Dependencies point downward only: `viz`/`ui` depend on `sim`, `sim` depends on
`raft`, and `raft` depends on nothing. The Raft layer imports nothing from the
rest of the app and is the pluckable artifact.

---

## 4. The Raft Core (`src/raft/`)

### 4.1 Sans-I/O design

The library never touches timers, the network, or `Math.random` directly. The
host drives every node:

- `tick(now)` — advance logical time; fires elections / heartbeats.
- `receive(message, now)` — deliver an RPC.
- `propose(command, now)` — submit a client command (leader only).
- `nextWakeAt()` — the earliest time the host must call `tick`.
- A seeded RNG is **injected** at construction.

Every call returns a `StepResult` describing what the world should do next:
messages to send, entries newly committed, and semantic events to narrate. This
makes the library **fully deterministic** (same seed + same inputs ⇒ same run)
and trivially testable without mocks.

### 4.2 Algorithm coverage (Raft paper, Figure 2 + §5.4)

- Leader election with randomized timeouts (§5.2).
- Log replication and the consistency check (§5.3).
- Election restriction — vote only for up-to-date logs (§5.4.1).
- Commit restriction — a leader only commits current-term entries by counting
  replicas (§5.4.2 / the Figure 8 rule).
- Crash (`stop`) and recovery (`restart`): persistent state (term, votedFor,
  log) survives; volatile state (role, commitIndex, leader) is rebuilt.

### 4.3 Fast log backup

On `AppendEntries` rejection, the follower returns a `conflictIndex` hint (first
index of its conflicting term, or one past its last entry for a short log). The
leader jumps `nextIndex` straight there instead of probing back one entry per
round trip. A node added behind a long log catches up in ~2 round trips instead
of O(L) — this is the dissertation's optimization and the fix for the worst UX
cliff (a freshly-added node otherwise crawls visibly for minutes).

### 4.4 Membership (documented simplification)

Cluster membership is changed out-of-band via `setPeers()` rather than joint-
consensus configuration entries. All nodes are told about the new membership by
the host. This matches the approach used by teaching tools like raftscope and is
called out explicitly in the code.

### 4.5 Live retuning

`setTiming()` retunes election-timeout and heartbeat values on a running node;
new values take effect from the next timer reset. This backs the UI timing
dials (§7.3).

### 4.6 Snapshots

`snapshot()` returns a complete, immutable view of node state. The log is
copy-on-write internally, so snapshots share the array and are cheap to take
every event — this is what makes the recorded timeline (§5.2) affordable.

---

## 5. The Simulation (`src/sim/`)

### 5.1 Discrete-event engine

A priority loop over the next message delivery and the next node wake-up.
Simulated time (sim-ms) is decoupled from wall time. Determinism is preserved by
a per-node seeded RNG plus a network RNG; the RNG is consumed a fixed number of
times per event regardless of branch outcomes, so changing a dial never desyncs
a seeded run.

### 5.2 Timeline recording & time travel

Every event produces a **Frame**: the complete cluster state (node snapshots,
per-node KV stores, in-flight messages, narrated events) at that instant. This
makes scrubbing **lossless** — any past moment can be rendered exactly.

- **Scrub backward** = pure playback. The recorded future is preserved.
- **Intervene in the past** = the timeline **forks**: `forkAt(t)` discards the
  future and the simulation diverges from that moment (with a toast to explain).
- A bounded ring of frames (`maxFrames`) caps memory; the scrubber's left edge
  is the retained horizon.

### 5.3 The network model (live-tunable)

`sim.network = { latency, jitter, loss }`, all mutable at runtime:

- One-way delay = `latency + U(0, jitter)`, with an **8% straggler tail**
  (1.6–2.2× delay) so out-of-order delivery stays visible. Raft's term/index
  checks absorb reordering correctly.
- **Packet loss**: a fraction of messages are doomed at send time. A lost packet
  still travels but **dies at 50% of its arc** — it reddens over its final
  stretch and explodes mid-flight (see §6.4). Drops to a removed/stopped node
  die at the destination instead.
- Messages in flight when their sender crashes are still delivered (realistic).

### 5.4 The KV state machine

A separate module applies committed log entries to a per-node `Map`. `set`
deletes-then-inserts so updated keys move to the end (insertion order = write
recency, surfaced newest-first in the UI). The store lives outside the Raft core
as opaque commands.

### 5.5 Autopilot ("auto mode")

Drives the cluster without user input so the scene tells a story on its own:

- **Client writes** on a cadence (gated by the autopilot master switch).
- **Chaos**: periodically crash the leader to force elections, then auto-restart
  it after a brief downtime. **Chaos is independent of the write switch** — the
  toggle means what it says — and arms its first crash promptly when enabled.
- Both default **off**; the demo loads quiet and the learner opts in.

### 5.6 Reset

`reset()` keeps the cluster shape (members + up/down states) but wipes history:
all nodes become term-0 followers with empty logs and stores, the timeline goes
blank, and a **fresh election** decides the new leader. The global Reset also
restores default network conditions and timing and turns chaos off.

### 5.7 Opening-election fast-start

On initial load and after Reset, election timers start ~75% elapsed (a fixed
offset subtracted from each deadline, leaving the randomized spread intact). The
first leader emerges within a beat instead of after a full timeout — without
distorting election dynamics.

---

## 6. The Visualization (`src/viz/`)

A WebGL scene (Three.js) for the cluster, with the DOM HUD layered on top.

### 6.1 Layout

Nodes sit on a ring (a "round table"). The camera is reframed with
`setViewOffset` so the cluster centers in the _unobstructed_ region — the dial
panels reserve space on the left, the inspector/KV/feed stack on the right, and
the timeline along the bottom. Label projection and click-picking go through the
same projection matrix, so they follow automatically.

### 6.2 Camera control

OrbitControls: left-drag orbits, right-drag pans, wheel/pinch zooms (clamped
distance and polar angle so you can't go under the floor). The click-vs-drag
threshold keeps node selection from firing on a drag.

### 6.3 Node rendering

- **Core + halo colored by term** (not role), using the shared term-color cycle.
  A node that slept through elections keeps its stale color until the new
  leader's first AppendEntries teaches it the term — the color change _is_ the
  catch-up.
- **Role** is encoded by: a depleting election-timer ring (term-colored),
  the label text, the role word, and a gold corona on the leader.
- **Down** nodes darken, sink, and drop their ring.
- A shader ring draws the election timer as a depleting arc.
- Bloom via `EffectComposer` + `UnrealBloomPass`, tuned so cores glow without
  blowing out to white.

### 6.4 Messages & effects

- Messages are glowing comets on raised bezier arcs, with opposing directions in
  separate lanes. Trails are sampled from the curve behind the head, so they
  render correctly even when scrubbing backward.
- Message color encodes type (vote request/grant/deny, append, heartbeat, ack).
- One-shot effects: election-win ripple, commit ripple, and the mid-arc **red
  burst** for a lost packet. Effects run on wall time (so they finish while
  paused) and clear on scrub-back/fork via an effect-epoch counter.

### 6.5 Per-node mini log strips

Under each node label, an 8-cell strip mirrors the replicated-log matrix:
dashed = missing entry, outlined = appended-but-uncommitted, filled = committed.
Cells share one global index window across nodes so they align — a lagging node
visibly shows dashes where peers show fills, then fills in as it catches up.

---

## 7. The HUD (`src/ui/`)

### 7.1 Topbar

Wordmark, live cluster stats (term, leader, node count), and actions:
**Add node**, **Remove node** (removes the newest; disabled at one node),
**Autopilot**, **Reset**.

### 7.2 Chaos panel (top-left)

Network failure controls, each with a mini Reset and a live value readout:

- **Leader crashes** toggle.
- **Packet loss** 0–100%.
- **Latency** 0.5–150 ms.
- **Jitter** 0–100 ms.

### 7.3 Raft timing panel (top-left, below Chaos)

The protocol's own dials, applied live to every node, with a mini Reset:

- **Election timeout** (base).
- **Timeout spread** (the randomization window — the split-vote dial).
- **Heartbeat** interval.
- A **stability readout** that warns when the worst round trip or heartbeat gap
  approaches the election timeout, or loss ≥ 25% — i.e. when re-elections become
  likely. This makes the paper's `broadcastTime ≪ electionTimeout` guidance
  tangible.

### 7.4 Right-hand stack

- **Node inspector** — click a node for role, term, votedFor, known leader,
  commit/applied indices, the election-timer bar, and **Stop / Restart /
  Remove**. (Restart on a live node bounces it: crash + recover.) The panel
  rebuilds only on structural change so buttons stay clickable.
- **Key-value store** — selection-aware: shows the selected node's applied state
  (titled "nX's view"), or the leader's view when the leader/nothing is
  selected. Entries are newest-first; **uncommitted** writes appear greyed
  (pending deletes greyed + struck through) and snap to full color on commit.
- **Event feed** — a narrated, color-coded log of elections, votes, commits,
  truncations, crashes, and drops, with consecutive duplicates coalesced.

### 7.5 Replicated log matrix (bottom-left)

One row per node, one column per log index (shared window), cells colored by
term: outlined = uncommitted, filled = committed, dotted = no-op, with a commit
flash. This is the canonical "are the logs converging?" view.

### 7.6 Timeline (bottom)

- Play/pause; a **logarithmic playback-speed slider** (0.001×–1×, default
  0.01×) with a live readout — equal drag = equal speed ratio.
- The **term tape**: a scrubber whose track is painted with the cluster's
  history — term epochs as colored bands, elections as gold ticks, crashes in
  red, client writes as notches. Time travel reads as reading the ledger.
- A **LIVE** indicator / jump-to-now button.
- Layout is ~40/60 between transport (slider) and the term tape.

### 7.7 Keyboard

Space = pause, `L` = jump live, arrows = scrub, `[` / `]` = slower/faster.

---

## 8. Visual Design

**Direction: "published paper over mission control."** The academic Raft paper
(serif, figures, §5.4) meets the machine room (monospace, glowing state).

- **Type:** _Instrument Serif_ (italic display — wordmark, big term numerals)
  over _IBM Plex Mono_ (all data and UI).
- **Palette:** deep ink-blue base (`#0a0e1a`, not pure black — bloom needs dark
  but tinted), haze panels, hairline borders. **Tide blue** (`#4fb6d8`) is the
  reserved interface/accent color and is deliberately _excluded_ from the term
  cycle to avoid overload.
- **Role colors** (for legend/labels): leader gold, candidate violet, follower
  tide, danger red.
- **Term cycle:** violet → orange → gold → mint → rose → periwinkle. Node cores,
  timer rings, log cells, mini strips, and the term-tape bands all share this
  cycle so the whole UI agrees on what "term N" looks like.
- **Signature element:** the term tape — the protocol's history encoded into the
  scrub bar.
- Accessibility floor: visible keyboard focus, `prefers-reduced-motion`
  respected (camera sway / starfield drift / pulses toned down), responsive down
  to hiding side panels on narrow screens.

---

## 9. Timing & Realism Model

Realism and watchability conflict: a real LAN cluster is idle ~97% of the time
at message timescale. Rather than distort the protocol, the product separates
the two concerns:

- **Protocol timing stays paper-real:** election timeout 150–300 ms, heartbeat
  50 ms.
- **The default network is a deliberate "teaching network":** latency 10 ms ±
  5 ms jitter (~10% of the election timeout, matching raftscope), so message
  flights are visible. This is labeled and tunable — dialing latency down to
  0.5 ms shows honest same-datacenter behavior (and why the demo stretches it).
- **Visibility lives in playback speed,** not in bent parameters. At the 0.01×
  default a message flight takes ~1–1.5 wall-seconds; at the 0.001× floor, ~10
  wall-seconds for frame-by-frame study.

Resulting healthy ratio: election timeout ≈ 5–100× round trip depending on the
latency dial, so the default opening election usually resolves in a single
round, while cranking latency or shrinking the timeout reproduces split votes
and re-election storms on demand.

---

## 10. Determinism & Reproducibility

- Same seed ⇒ identical run. A `?seed=N` URL parameter reproduces a specific
  history; omitting it picks a random seed.
- Live dial changes only affect future sends at the live edge, so recorded
  history stays valid (no fork needed for a knob change — only for a past-time
  intervention).

---

## 11. Quality Bar

- `raft-core` and `sim` carry a deterministic test suite (election safety,
  replication, the Figure 8 commit rule, crash/recovery, fast backup,
  membership catch-up, packet loss, reset semantics, chaos-without-autopilot).
- `vp check` (format + lint + types) and `vp test` are green on every change.
- The app builds clean via `vp build`.

---

## 12. Tech Stack

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`).
- **Toolchain:** Vite+ (`vp`) — dev, check (Oxlint/Oxfmt/tsgo), test (Vitest),
  build (Rolldown).
- **Rendering:** Three.js (WebGL scene + bloom post-processing) with a DOM HUD.
- **Dependencies:** Three.js and self-hosted fonts only. The Raft core has zero
  runtime dependencies.

---

## 13. Future Opportunities

- Network partitions as a first-class control (the sim supports the mechanics).
- Optional log compaction / snapshot install (§7) to bound log growth.
- A guided tour / scripted scenarios for first-time learners.
- Shareable permalinks that encode seed + dial settings.

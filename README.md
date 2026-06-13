# Raft — Consensus, Visualized

An interactive, scrubbable visualization of the [Raft consensus
algorithm](https://raft.github.io/). Watch a cluster of nodes hold an election,
replicate an immutable log, agree on a value, survive crashes, and recover — all
rendered as a living scene you can pause, rewind, speed up, and poke at.

**▶ Live: http://maxanderson.tech/raft-visualization/**

The simulated system is a fictional replicated key-value store (think etcd), but
the store is just a prop. The real subject is Raft itself: how a group of
machines with no shared clock and an unreliable network nevertheless agree on a
single, consistent sequence of events.

---

## What is Raft, briefly

Raft keeps a cluster of servers in agreement on an ordered log of commands. It
works by electing one **leader** that accepts all writes and replicates them to
the **followers**. If the leader disappears, the remaining nodes hold a new
election. A command is **committed** — promised never to be lost — once a
majority of nodes have stored it. Time is divided into numbered **terms**, each
beginning with an election.

This visualization makes every one of those mechanics something you can see
happen.

---

## Reading the scene

Nodes sit in a ring. Each one shows its identity, its role, and the state of its
log.

### Node colors

- **Color = term.** Every node is tinted by the term it currently believes it's
  in, using a repeating color cycle (violet → orange → gold → mint → rose →
  periwinkle). When the cluster moves to a new term, the nodes change color. A
  node that was asleep or crashed keeps its **old** color until it hears from the
  new leader and catches up — so the color change _is_ the node catching up.
- **Role** is shown by the label (`LEADER` / `FOLLOWER` / `CANDIDATE` / `DOWN`),
  a gold halo on the leader, and a depleting ring around followers and
  candidates.

### The election timer ring

Followers and candidates have a ring that slowly empties. That's the **election
timeout** counting down. If it runs out before the node hears from a leader, the
node becomes a candidate and starts a new election. Every node's timeout is
slightly randomized — that's what stops them all campaigning at once.

### Messages

Glowing comets travel between nodes. Their color tells you what they are:

- **Vote requests** and **grants** — election traffic.
- **AppendEntries** — the leader replicating log entries (and the steady
  **heartbeats** that keep its authority alive).
- **Acknowledgements** flowing back to the leader.

If you turn on packet loss, doomed messages redden and **explode mid-flight**
instead of arriving. During a network partition, messages that try to cross
between the two groups slam into the dividing wall and burst there.

### The mini log strip

Under each node is a small row of cells — its recent log. Each cell is one entry:

- **Filled** — committed (safely agreed by a majority).
- **Outlined** — present on this node but not yet committed.
- **Dashed** — this node is missing that entry entirely.

Because every node's strip lines up column-for-column, you can watch a node that
fell behind fill in its missing entries as it catches up.

---

## The panels

### Chaos (top-left)

Break the network and watch Raft cope:

- **Leader crashes** — periodically kills the leader so you can watch
  re-elections happen on their own.
- **Network partition** (`½` / `⅓` / `¼`) — sever the cluster into two groups,
  splitting off roughly that fraction of the nodes into an isolated minority. A
  glowing barrier slices across the scene, and any message that tries to cross
  it races to the wall and detonates. The split is a random arc of the ring, so
  it may or may not strand the current leader. **Heal partition** reconnects the
  two sides. (See _Partitions, for real_ below for what to watch for.)
- **Packet loss** — drop a percentage of messages (0–100%). Crank it up and
  consensus stalls; ease it back and the cluster recovers.
- **Latency** and **jitter** — how long messages take, and how much that varies.

Each control has its own **reset**.

#### Partitions, for real

A partition is just the network refusing to carry messages between the two
groups — and because the Raft library underneath is faithful to the paper, the
right behavior falls out on its own. What you'll see depends on which side the
leader lands:

- **Leader in the majority.** It still has a quorum, so it keeps committing
  without missing a beat. The stranded minority can't hear it, times out, and
  campaigns over and over — but it can never gather a majority of the _whole_
  cluster, so it just churns through terms with no winner.
- **Leader in the minority.** Now it's cut off from a quorum, so it stays
  "leader" but **can't commit anything** — writes pile up in its log, forever
  uncommitted. Meanwhile the majority side notices the silence, holds an
  election, and crowns a **new leader in a higher term**. For a moment the
  cluster has two leaders — classic split-brain — but only the majority's is
  able to make promises.

When you **heal** the split, the stale leader hears a message from the higher
term, immediately steps down, throws away its uncommitted entries, and adopts
the winner's log. The cluster reconverges on one history.

One thing to watch: because this implementation tracks the original paper (no
_Pre-Vote_ or _leader lease_), the minority's ever-climbing term can briefly
**disrupt** a perfectly healthy leader the instant the link returns, forcing one
more election before things settle. That's not a bug — it's exactly the problem
those later refinements were invented to solve.

### Raft timing (top-left)

Tune the protocol's own dials and see the consequences live:

- **Election timeout** — how long a node waits before campaigning.
- **Timeout spread** — how much that wait is randomized. Shrink it and watch
  split votes (multiple candidates at once) become common.
- **Heartbeat** — how often the leader reasserts itself.

A readout at the bottom warns you when your settings make the cluster
unstable — for example, when messages take so long they can outlive the election
timer and trigger needless re-elections. It's a hands-on way to feel _why_ real
clusters are tuned the way they are.

### Node inspector (right)

Click any node to see its internals: current term, who it voted for, who it
thinks the leader is, how much of its log is committed, and its election timer.
From here you can **Stop** a node (crash it), **Restart** it (a stopped node
comes back; a running node gets bounced and rebuilds from its log), or **Remove**
it from the cluster.

### Key-value store (right)

The committed contents of the store. By default it shows the **leader's** view;
click a node to see **that node's** view instead — handy for spotting a follower
that hasn't caught up. Entries that are in a node's log but not yet committed
appear greyed out, then snap to full color the moment they commit. You can write
your own keys with the **Set** form.

### Event feed (right)

A running, plain-language narration of what just happened: who timed out, who
voted for whom, who won, what got committed, what got truncated, and what
crashed.

### Replicated log (bottom-left)

The whole cluster's logs side by side, one row per node, colored by term. This
is the canonical "are all the logs converging on the same history?" view.

---

## Controlling time

The bottom bar is a full timeline of everything that has happened.

- **Play / pause.**
- **Speed slider** — from `1×` all the way down to `0.001×`. Raft happens in
  milliseconds; slowing time down is how you actually see individual messages
  fly and timers tick. The default is a calm, watchable pace.
- **The term tape** — the scrubber itself is painted with history: colored bands
  for each term, gold ticks where elections happened, red where nodes crashed,
  and small notches for client writes. **Drag it to travel back in time** and
  replay any moment.
- **LIVE** — jump back to the present edge of the simulation.

Scrubbing backward is pure replay — the future you already saw stays intact. But
if you _act_ in the past (write a key, crash a node), the timeline **forks** from
that moment and history rewrites itself from there.

**Keyboard:** `Space` play/pause · `←` / `→` scrub · `[` / `]` slower / faster ·
`L` jump to live · `Esc` deselect.

---

## The top bar

- **Add node / Remove node** — grow or shrink the cluster and watch it
  reconfigure.
- **Autopilot** — hands-off mode: the cluster issues its own writes so you can
  just watch the story unfold. (Pair it with Chaos for a self-running demo.)
- **Reset** — start the cluster over: same nodes, fresh history, a brand-new
  election from term one.

The cluster's current **term**, **leader**, and **node count** are always shown
up top.

---

## Things to try

- **Watch a clean election.** Load the page and watch the very first leader get
  chosen. Slow the speed down if it goes by too fast.
- **Kill the leader.** Open the inspector, select the leader, hit **Stop**, and
  watch a follower time out and win the next term. Notice the term color change.
- **Make a node fall behind.** Stop a follower, write a few keys, then restart
  it — watch the dashed cells in its log strip fill in as the leader catches it
  up, and its color flip to the current term.
- **Break the network.** Push packet loss toward 100% and watch the cluster fail
  to make progress; ease it back and watch it heal.
- **Split the brain.** Hit `½` to partition the cluster and watch the wall go up.
  Keep splitting until the leader lands on the _minority_ side: it freezes
  (committing nothing) while the majority elects a rival leader in a new term.
  Then **heal** it and watch the loser step down and its orphaned entries
  vanish.
- **Cause chaos on purpose.** Shrink the **timeout spread** until elections
  routinely split between multiple candidates — then widen it again and see the
  splits disappear. That single dial is the whole reason Raft randomizes its
  timers.

---

## A note on realism

Real datacenter networks are fast — messages cross in well under a millisecond,
which would make them invisible here. So the **default network is deliberately
"stretched"** (about 10 ms latency) purely so you can watch messages travel; the
protocol's own timing stays true to the Raft paper. If you want to see what a
genuine same-datacenter cluster behaves like, drop the latency dial down toward
its minimum — you'll see the cluster sit almost completely idle between brief
bursts of activity, which is exactly the point.

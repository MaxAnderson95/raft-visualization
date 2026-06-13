/**
 * raft-core: a dependency-free, deterministic, sans-I/O implementation of
 * the Raft consensus algorithm.
 *
 * This directory is self-contained — it imports nothing from the rest of
 * the application and can be lifted out and reused as-is.
 */

export { DEFAULT_TIMING, RaftNode } from "./node.ts";
export type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  LogEntry,
  NodeId,
  ProposeResult,
  RaftEvent,
  RaftMessage,
  RaftNodeOptions,
  RaftNodeSnapshot,
  RaftTimingOptions,
  RequestVoteRequest,
  RequestVoteResponse,
  Role,
  StepResult,
} from "./types.ts";

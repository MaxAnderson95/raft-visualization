/**
 * The fictional key-value store replicated by Raft. Commands are the log
 * entry payload; each node materializes its own copy of the store by
 * applying committed entries in order.
 */

export type KVCommand =
  | { readonly op: "set"; readonly key: string; readonly value: string }
  | { readonly op: "del"; readonly key: string }
  | { readonly op: "noop" };

/** Apply one committed command. Returns a new map only when state changes. */
export function applyCommand(
  state: ReadonlyMap<string, string>,
  command: KVCommand,
): ReadonlyMap<string, string> {
  switch (command.op) {
    case "set": {
      if (state.get(command.key) === command.value) return state;
      const next = new Map(state);
      // Delete first so re-set keys move to the end: map order = write
      // recency, which the UI shows newest-first.
      next.delete(command.key);
      next.set(command.key, command.value);
      return next;
    }
    case "del": {
      if (!state.has(command.key)) return state;
      const next = new Map(state);
      next.delete(command.key);
      return next;
    }
    case "noop":
      return state;
  }
}

export function formatCommand(command: KVCommand): string {
  switch (command.op) {
    case "set":
      return `SET ${command.key}=${command.value}`;
    case "del":
      return `DEL ${command.key}`;
    case "noop":
      return "no-op";
  }
}

/**
 * Single source of truth for colors shared between WebGL, canvas drawing,
 * and DOM. Keep in sync with the CSS custom properties in style.css.
 */

export const INK = 0x0a0e1a;

export const ROLE_COLORS = {
  leader: 0xffc24b,
  candidate: 0xc77dff,
  follower: 0x4fb6d8,
  stopped: 0x3a4356,
} as const;

export const ROLE_CSS = {
  leader: "#ffc24b",
  candidate: "#c77dff",
  follower: "#4fb6d8",
  stopped: "#5b6478",
} as const;

/** Message palette: election traffic is warm/violet, replication is tidal. */
export const FLIGHT_COLORS = {
  voteReq: 0xc77dff,
  voteGrant: 0xffe9b8,
  voteDeny: 0x6b5a86,
  append: 0x59d6f2,
  heartbeat: 0x2e7d96,
  ackOk: 0x93accc,
  ackNo: 0xff6b6b,
} as const;

export type FlightKind = keyof typeof FLIGHT_COLORS;

/**
 * Log entries / term tape cycle through these by term number.
 * Deliberately excludes the tide blue (#4fb6d8) — that hue is the
 * follower/interface accent and must stay unambiguous.
 */
export const TERM_CYCLE = [
  "#c77dff",
  "#ff7a45",
  "#ffc24b",
  "#7be0ad",
  "#ff8fa3",
  "#9da8ff",
] as const;

export function termColor(term: number): string {
  return TERM_CYCLE[(term - 1 + TERM_CYCLE.length * 1000) % TERM_CYCLE.length] ?? "#4fb6d8";
}

export const DANGER = "#ff6b6b";

export const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

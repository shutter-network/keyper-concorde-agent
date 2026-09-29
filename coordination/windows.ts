// Time windows and what they have in common.
//
// Pure arithmetic, and deliberately not the model's job: turning "3-5pm CET" into an interval needs
// language, but deciding whether five intervals overlap does not, and a model that gets it wrong
// reports a time nobody can make with total confidence.
//
// Everything here is UTC. The model normalises at the moment it records an answer, so nothing
// downstream carries a zone.

export type Window = {
  readonly from: Date;
  readonly to: Date;
};

export class MalformedWindowError extends Error {
  constructor(from: string, to: string, why: string) {
    super(`${JSON.stringify(from)} to ${JSON.stringify(to)} is not a window: ${why}`);
    this.name = "MalformedWindowError";
  }
}

// Refused rather than recorded, because a window nobody can parse is worse stored than rejected: it
// would count towards the round being complete while meaning nothing.
export function parseWindow(from: string, to: string): Window {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime())) throw new MalformedWindowError(from, to, "the start is not a time");
  if (Number.isNaN(end.getTime())) throw new MalformedWindowError(from, to, "the end is not a time");
  if (end.getTime() <= start.getTime()) {
    throw new MalformedWindowError(from, to, "the end is not after the start");
  }
  return { from: start, to: end };
}

// The window every one of them covers, or undefined when there is none. Touching at an endpoint is
// not an overlap: a DKG cannot happen in zero time, and reporting an instant as a window would read
// as agreement where there is none.
export function overlapOf(windows: readonly Window[]): Window | undefined {
  if (windows.length === 0) return undefined;
  const from = new Date(Math.max(...windows.map((w) => w.from.getTime())));
  const to = new Date(Math.min(...windows.map((w) => w.to.getTime())));
  return to.getTime() > from.getTime() ? { from, to } : undefined;
}

/** The most operators that can agree on one window, and which of them. */
export type Agreement<T> = {
  readonly window: Window;
  readonly members: readonly T[];
};

/**
 * The largest group that shares a window, when not everybody does.
 *
 * Turns "no window works" into "these four can do 12:00-13:00, only this one cannot", which is the
 * difference between starting over and negotiating with one operator. Diagnostic only: what the team
 * does next -- ask the outlier, or open a fresh round suggesting a day -- is theirs to decide.
 *
 * Fewer than two agreeing is not an agreement, so that returns nothing: "1 of 5 overlap" says
 * nothing a list of windows did not already say.
 *
 * Every window a group can share begins where one of the members' windows begins, so the starts are
 * the only candidates worth testing. Quadratic, which is nothing at the size of a keyperset, and far
 * easier to check by eye than a sweep.
 */
export function largestAgreement<T extends { readonly window: Window }>(
  entries: readonly T[],
): Agreement<T> | undefined {
  let best: Agreement<T> | undefined;
  for (const candidate of entries) {
    const at = candidate.window.from.getTime();
    // `to > at` rather than `>=`: a window that merely ends where another starts shares no time.
    const members = entries.filter((e) => e.window.from.getTime() <= at && e.window.to.getTime() > at);
    if (members.length < 2) continue;
    const window = overlapOf(members.map((m) => m.window));
    if (window === undefined) continue;
    const width = window.to.getTime() - window.from.getTime();
    const bestWidth = best === undefined ? -1 : best.window.to.getTime() - best.window.from.getTime();
    // More operators first, then the wider window: the widest is the easiest to negotiate around.
    if (
      best === undefined ||
      members.length > best.members.length ||
      (members.length === best.members.length && width > bestWidth)
    ) {
      best = { window, members };
    }
  }
  return best;
}

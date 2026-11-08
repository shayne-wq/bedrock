// Bedrock — what the reported metres say about when a programme finishes.
//
// ONE COPY, read by two things. The deck viewer inlines this file at build
// time (tools/build_present.py, which strips the `export` keywords) and the
// console imports it. That is not tidiness: the console's job is to tell an
// issuer what their own deck is about to claim in public — "your deck now
// shows a finish three months after the date on your plan" — and a second
// implementation of these rules would eventually say that about a deck showing
// something else. The claim and the warning about the claim have to be the
// same arithmetic.
//
// Everything an issuer types is a figure they are accountable for. Everything
// here is derived from those figures, which makes it the only part of a deck
// that nobody has checked — so every step below REFUSES rather than guesses,
// and the panel that prints a result also prints what it was computed from.
//
// THE PACE WINDOW IS THE WHOLE PROGRAMME: started_on at zero metres through to
// the newest report carrying a figure, not the gap between the last two
// reports. Three reasons, in the order they matter.
//
//   It is REPRODUCIBLE. The reader divides the two numbers already on their
//   screen and gets the same answer. A trailing window is a number they cannot
//   check against anything the deck shows them.
//
//   It is CONSERVATIVE. Mobilisation and standdown days count against the
//   metres drilled, so it reads as the slower rig and the later date — the
//   right direction for an error on a screen a shareholder reads.
//
//   It QUALIFIES SOONEST. It has the longest span, so a programme whose only
//   two reports are a week apart still has a usable rate. Insisting on a
//   trailing window would mean no forecast through the first month of every
//   programme, which is the month it is asked about most.

export const DRILL = {
  MIN_SPAN: 10,   // days — a shorter window is one good week, not a rate
  MAX_FC: 730,    // days — past two years, a projected date is a joke
  STALE: 45,      // days without a report — say so
  COLD: 90,       // days without a report — and stop projecting from it
  DAY: 864e5,
};

/** Null for anything that is not a finite number. `Number(null)` is 0 and 0 is
 *  finite, which is how a programme with no coordinates once put a rig off the
 *  coast of Africa; the same shape of bug reads a missing metre count as a
 *  programme that has drilled nothing. */
export const dNum = (v) =>
  (v === null || v === undefined || v === "") ? null : (isFinite(+v) ? +v : null);

/** A date arrives as `YYYY-MM-DD`. Parsed without a zone, engines disagree
 *  about whether that is local or UTC midnight, which moves a report a day
 *  either side of the date the issuer typed. Pinned to UTC at both ends. */
export function dDay(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + "T00:00:00Z");
  return isNaN(+d) ? null : +d;
}

const ups = (g) => (g && g.updates) || [];

/** The newest report carrying a metre count. A report can legitimately be
 *  words only — "rig mobilised, first hole collared" — and reading the total
 *  off whatever happens to be newest would blank out yesterday's figure. */
export const drillReport = (g) =>
  ups(g).find((u) => dNum(u.metres_total) !== null) || null;

export function drillMetres(g) {
  const u = drillReport(g);
  return u ? dNum(u.metres_total) : null;
}

/** The same reasoning, one field at a time. A report that mobilises a second
 *  rig without adding a metre is the newest word on how many holes are turning
 *  and says nothing at all about the total — so reading both off the newest
 *  METRE-bearing row shows whatever that row happened to carry, and the panel
 *  said one hole was turning on the day a second rig arrived. */
export function drillField(g, key) {
  for (const u of ups(g)) {
    const v = dNum(u[key]);
    if (v !== null) return v;
  }
  return null;
}

/** Metre-bearing reports, OLDEST FIRST. They arrive newest-first for the
 *  panel's list and every derivation here reads forward through time. */
export const drillAsc = (g) =>
  ups(g).filter((u) => dNum(u.metres_total) !== null && dDay(u.as_of) !== null)
    .slice().sort((a, b) => dDay(a.as_of) - dDay(b.as_of));

/** Metres per day, and the window it was measured over. Null when there is no
 *  window worth dividing by. */
export function drillPace(g) {
  const A = drillAsc(g);
  if (!A.length) return null;
  const t1 = dDay(A[A.length - 1].as_of), m1 = dNum(A[A.length - 1].metres_total);
  let t0 = dDay(g.started_on), m0 = 0, from = g.started_on;
  if (t0 === null || t0 >= t1) {
    // No start date, or — bad data — one that is not before the last report.
    // Fall back to the reports' own span, which takes two of them. Dividing by
    // a negative span would read as a rig drilling backwards.
    if (A.length < 2) return null;
    t0 = dDay(A[0].as_of); m0 = dNum(A[0].metres_total); from = A[0].as_of;
  }
  const days = (t1 - t0) / DRILL.DAY;
  if (!(days >= DRILL.MIN_SPAN) || !(m1 > m0)) return null;
  return { mpd: (m1 - m0) / days, days: Math.round(days), from,
           to: A[A.length - 1].as_of, metres: m1 - m0 };
}

export const fmtPace = (mpd) =>
  (mpd >= 10 ? Math.round(mpd) : Math.round(mpd * 10) / 10).toLocaleString() + " m/day";

/** Days since the last report that carried a metre count. */
export function drillStaleDays(g, now) {
  const A = drillAsc(g);
  if (!A.length) return null;
  return Math.floor(((now === undefined ? Date.now() : now) -
    dDay(A[A.length - 1].as_of)) / DRILL.DAY);
}

/** When the committed metres are reached at the pace that has been reported.
 *
 *  Null — and the panel then says nothing at all rather than something
 *  qualified into meaninglessness — when there is no target to finish AGAINST;
 *  when the programme is paused or complete, because a pace measured while the
 *  rig was turning projects nothing about a rig that has stopped; when the
 *  target is already met; when the last report is older than COLD, by which
 *  point the rate is history rather than evidence of anything current; or when
 *  the answer is more than two years out. */
export function drillForecast(g, now) {
  const at = now === undefined ? Date.now() : now;
  const t = dNum(g.target_m), m = drillMetres(g);
  if (!t || m === null) return null;
  if (g.status === "complete" || g.status === "paused") return null;
  const remaining = t - m;
  if (remaining <= 0) return null;
  const p = drillPace(g);
  if (!p) return null;
  const stale = drillStaleDays(g, at);
  if (stale !== null && stale > DRILL.COLD) return null;
  const left = Math.ceil(remaining / p.mpd);
  if (!isFinite(left) || left <= 0 || left > DRILL.MAX_FC) return null;
  // Anchored at the LATER of the last report and today. Anchored on the report
  // alone, the finish date slides into the past the moment a report is a month
  // old; anchored on today alone, it assumes nothing has been drilled since
  // the last report, which is also what it quietly claims. The later of the
  // two is the only one of the three that is never absurd, and a report stale
  // enough for the difference to matter has already said so in its own line.
  const on = new Date(Math.max(dDay(p.to), at) + left * DRILL.DAY);
  const plan = dDay(g.expected_end);
  return { iso: on.toISOString().slice(0, 10), days: left, remaining, pace: p,
           vs: plan === null ? null : Math.round((+on - plan) / DRILL.DAY) };
}

/** "about 3 weeks later than planned". Coarsened as it goes out, because a
 *  projection is not good to the day and printing one to the day says it is. */
export function drillVariance(d) {
  const a = Math.abs(d);
  if (a <= 5) return "on the planned date";
  const dir = d > 0 ? "later than planned" : "earlier than planned";
  if (a < 14) return a + " days " + dir;
  if (a < 60) return "about " + Math.round(a / 7) + " weeks " + dir;
  return "about " + Math.round(a / 30) + " months " + dir;
}

/** Everything derived about one programme, in one object. */
export function drillCalc(g, now) {
  const p = drillPace(g), f = drillForecast(g, now);
  return {
    pace: p ? Math.round(p.mpd * 100) / 100 : null,
    span: p ? p.days : null, from: p ? p.from : null, to: p ? p.to : null,
    forecast: f ? f.iso : null, days: f ? f.days : null, vs: f ? f.vs : null,
    remaining: f ? f.remaining : null, stale: drillStaleDays(g, now),
    variance: (f && f.vs !== null) ? drillVariance(f.vs) : null,
  };
}

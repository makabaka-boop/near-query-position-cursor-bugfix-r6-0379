import { normalizeTerm } from "./tokenizer.js";

export function normalizeNear(clauses = []) {
  if (!Array.isArray(clauses)) throw new Error("near must be an array");
  return clauses.map((clause) => {
    if (
      !Array.isArray(clause.terms) ||
      clause.terms.length < 2 ||
      clause.terms.length > 8 ||
      !Number.isInteger(clause.maxGap) ||
      clause.maxGap < 0 ||
      clause.maxGap > 16 ||
      typeof clause.ordered !== "boolean"
    )
      throw new Error("invalid near clause");
    return {
      terms: clause.terms.map(normalizeTerm),
      maxGap: clause.maxGap,
      ordered: clause.ordered,
    };
  });
}

const postings = (doc, term) =>
  doc.postings instanceof Map
    ? (doc.postings.get(term) ?? [])
    : (doc.postings[term] ?? []);

function positionsOf(doc, term) {
  return postings(doc, term).map((entry) => entry.position);
}

/** First index whose value is >= target (positions are sorted and unique). */
function lowerBound(sorted, target) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// gap = number of non-selected tokens strictly inside the covering window.
const withinGap = (start, end, selected, maxGap) =>
  end - start - (selected - 1) <= maxGap;

/**
 * Ordered clauses: for every occurrence of the first term that can complete,
 * greedily pick the earliest legal occurrence for each following clause term.
 * Each selected term consumes a distinct token, so a repeated clause term
 * requires repeated occurrences. The greedy choice yields the earliest
 * completion (smallest gap) for a given starting occurrence.
 */
function orderedWindows(lists, maxGap) {
  const windows = [];
  const [first, ...rest] = lists;
  start: for (const start of first) {
    const chosen = [start];
    let previous = start;
    for (const list of rest) {
      const idx = lowerBound(list, previous + 1);
      if (idx >= list.length) continue start;
      previous = list[idx];
      chosen.push(previous);
      if (!withinGap(start, previous, chosen.length, maxGap)) continue start;
    }
    windows.push({ start, end: previous, positions: chosen });
  }
  return windows;
}

/**
 * Unordered clauses: enumerate minimal covering windows over the merged
 * occurrence stream. A window is minimal when removing either endpoint breaks
 * coverage of the required-term multiset; each requirement consumes a distinct
 * token occurrence, including repeated clause terms.
 */
function unorderedWindows(terms, lists, maxGap) {
  // Occurrences are grouped by the actual term, not by clause slot: each token
  // exists once even when a clause repeats a term. Multiplicity expresses how
  // many occurrences of a term the clause consumes.
  const uniqueTerms = [...new Set(terms)];
  const listByTerm = new Map(terms.map((term, slot) => [term, lists[slot]]));
  const occurrences = uniqueTerms
    .map((term) =>
      (listByTerm.get(term) ?? []).map((position) => ({ position, term })),
    )
    .flat()
    .sort((a, b) =>
      a.position === b.position
        ? a.term.localeCompare(b.term)
        : a.position - b.position,
    );

  const required = new Map();
  for (const term of terms)
    required.set(term, (required.get(term) ?? 0) + 1);

  const windows = [];
  const counts = new Map();
  let satisfied = 0;
  let left = 0;

  const add = (occ) => {
    const have = counts.get(occ.term) ?? 0;
    counts.set(occ.term, have + 1);
    if (have + 1 === required.get(occ.term)) satisfied++;
  };
  const remove = (occ) => {
    const have = counts.get(occ.term);
    counts.set(occ.term, have - 1);
    if (have === required.get(occ.term)) satisfied--;
  };

  for (let right = 0; right < occurrences.length; right++) {
    add(occurrences[right]);
    while (satisfied === required.size) {
      const leftOcc = occurrences[left];
      // Drop redundant left occurrences while coverage survives.
      if ((counts.get(leftOcc.term) ?? 0) > required.get(leftOcc.term)) {
        remove(leftOcc);
        left++;
        continue;
      }
      // Both endpoints are essential: this is a minimal covering window.
      const start = leftOcc.position;
      const end = occurrences[right].position;
      if (withinGap(start, end, lists.length, maxGap)) {
        windows.push(buildWindow(terms, lists, start, end));
      }
      remove(leftOcc);
      left++;
    }
  }
  return windows;
}

/**
 * Deterministic evidence for a covering window: for each clause slot, take the
 * earliest occurrence of its term inside [start, end] that is not consumed by
 * an earlier slot (repeated term slots therefore use distinct occurrences).
 * Positions are returned in clause (slot) order.
 */
function buildWindow(terms, lists, start, end) {
  // Repeated clause terms share one cursor so the slots consume distinct
  // occurrences; distinct terms are tracked independently.
  const cursors = new Map();
  const positions = terms.map((term, slot) => {
    const list = lists[slot];
    const index = cursors.get(term) ?? lowerBound(list, start);
    cursors.set(term, index + 1);
    return list[index];
  });
  return { start, end, positions };
}

export function nearEvidence(doc, clause) {
  const lists = clause.terms.map((term) => positionsOf(doc, term));
  if (lists.some((list) => list.length === 0)) return [];
  return clause.ordered
    ? orderedWindows(lists, clause.maxGap)
    : unorderedWindows(clause.terms, lists, clause.maxGap);
}

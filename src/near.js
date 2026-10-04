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

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// How many entries of a unique, sorted position list are <= value.
function countLE(sorted, value) {
  return lowerBound(sorted, value + 1);
}

function termCounts(terms) {
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/**
 * Ordered clauses: for every occurrence of the first query term, greedily take
 * the earliest strictly-later occurrence of each following term. Repeated terms
 * consume distinct token occurrences. Each completion whose total number of
 * intervening (non-selected) tokens fits maxGap is reported; per the documented
 * semantics it is the earliest completion for that starting occurrence.
 */
function orderedWindows(positionsByTerm, clause) {
  const windows = [];
  const first = positionsByTerm.get(clause.terms[0]);
  outer: for (const start of first) {
    const positions = [start];
    for (let i = 1; i < clause.terms.length; i++) {
      const sorted = positionsByTerm.get(clause.terms[i]);
      const idx = lowerBound(sorted, positions[i - 1] + 1);
      if (idx === sorted.length) break outer;
      positions.push(sorted[idx]);
    }
    const end = positions[positions.length - 1];
    if (end - start - (positions.length - 1) <= clause.maxGap) {
      windows.push({ start, end, positions });
    }
  }
  return windows;
}

/**
 * Merge per-term position lists (each sorted) into one sorted stream.
 * A token position belongs to exactly one term, so no ties occur.
 */
function mergeTermPositions(uniqueTerms, positionsByTerm) {
  const indices = new Map(uniqueTerms.map((term) => [term, 0]));
  const merged = [];
  for (;;) {
    let nextPos = null;
    let nextTerm = null;
    for (const term of uniqueTerms) {
      const pos = positionsByTerm.get(term)[indices.get(term)];
      if (pos !== undefined && (nextPos === null || pos < nextPos)) {
        nextPos = pos;
        nextTerm = term;
      }
    }
    if (nextPos === null) break;
    merged.push({ position: nextPos, term: nextTerm });
    indices.set(nextTerm, indices.get(nextTerm) + 1);
  }
  return merged;
}

/**
 * Unordered clauses: require the multiset of query terms. Enumerate minimal
 * covering windows: for every occurrence that could be the left edge, greedily
 * extend to the earliest end covering every required multiplicity. Windows
 * whose left-edge occurrence is redundant (not tight) are skipped, and the
 * remaining minimal windows must have at most maxGap intervening nonselected
 * tokens.
 */
function unorderedWindows(positionsByTerm, clause) {
  const counts = termCounts(clause.terms);
  const uniqueTerms = [...counts.keys()];

  const merged = mergeTermPositions(uniqueTerms, positionsByTerm);
  const windows = [];
  for (const { position: start, term: startTerm } of merged) {
    let end = -1;
    for (const [term, required] of counts) {
      const sorted = positionsByTerm.get(term);
      const idx = lowerBound(sorted, start);
      if (idx + required > sorted.length) return windows;
      end = Math.max(end, sorted[idx + required - 1]);
    }

    // Tightness at the left edge: within [start, end] the start term may occur
    // exactly its required multiplicity, so the occurrence at `start` is
    // necessary. Occurrences before `start` do not count toward the window.
    const startSorted = positionsByTerm.get(startTerm);
    const inWindow =
      countLE(startSorted, end) - lowerBound(startSorted, start);
    if (inWindow !== counts.get(startTerm)) continue;

    if (end - start + 1 - clause.terms.length <= clause.maxGap) {
      const positions = [];
      for (const [term, required] of counts) {
        const sorted = positionsByTerm.get(term);
        const idx = lowerBound(sorted, start);
        for (let k = 0; k < required; k++) positions.push(sorted[idx + k]);
      }
      positions.sort((a, b) => a - b);
      windows.push({ start, end, positions });
    }
  }
  return windows;
}

export function nearEvidence(doc, clause) {
  // Repeated terms share the same postings list but consume distinct
  // occurrences during matching.
  const positionsByTerm = new Map();
  for (const term of new Set(clause.terms)) {
    positionsByTerm.set(
      term,
      postings(doc, term).map((hit) => hit.position),
    );
  }

  const counts = termCounts(clause.terms);
  for (const [term, required] of counts) {
    if (positionsByTerm.get(term).length < required) return [];
  }

  return clause.ordered
    ? orderedWindows(positionsByTerm, clause)
    : unorderedWindows(positionsByTerm, clause);
}

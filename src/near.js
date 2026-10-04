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
export function nearEvidence(doc, clause) {
  const positions = clause.terms.map((t) => postings(doc, t)[0]?.position);
  if (positions.some((p) => p === undefined)) return [];
  const start = Math.min(...positions),
    end = Math.max(...positions);
  return end - start - (positions.length - 1) <= clause.maxGap
    ? [{ start, end, positions }]
    : [];
}

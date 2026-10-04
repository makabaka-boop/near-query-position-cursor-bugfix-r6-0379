import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentStore } from "../src/index.js";
import {
  cleanup,
  compareQueryResults,
  makeTempDir,
  ReferenceModel,
} from "./reference.js";

const dirs = [];

function dir(label) {
  const path = makeTempDir(label);
  dirs.push(path);
  return path;
}

test.after(() => cleanup(dirs));

test("indexes updates, tombstones, terms and consecutive phrases", async () => {
  const path = dir("basic");
  const store = await DocumentStore.open({ directory: path });

  await store.put("a", "quick brown fox quick", 1);
  await store.put("b", "Quick! brown; deer 123", 2);
  await store.put("c", "fox hound quick brown dog", 3);
  await store.delete("b", 4);
  await store.put("a", "quick brown fox updated", 5);

  const termResult = store.query({ terms: ["QUICK", "fox"] });
  const reference = new ReferenceModel();
  reference.put("a", "quick brown fox quick", 1);
  reference.put("b", "Quick! brown; deer 123", 2);
  reference.put("c", "fox hound quick brown dog", 3);
  reference.delete("b", 4);
  reference.put("a", "quick brown fox updated", 5);
  compareQueryResults(
    assert,
    termResult.results,
    reference.query({ terms: ["QUICK", "fox"] }),
  );

  const a = termResult.results.find((doc) => doc.id === "a");
  assert.deepEqual(
    a.evidence.terms.quick.map((hit) => hit.position),
    [0],
  );
  assert.deepEqual(
    a.evidence.terms.fox.map((hit) => hit.position),
    [2],
  );
  assert.equal(a.revision, 5);
  assert.equal(store.getDocument("b"), null);

  const phrase = store.query({ phrases: ["brown fox"] });
  assert.deepEqual(phrase.results.map((doc) => doc.id).sort(), ["a"]);
  assert.deepEqual(phrase.results[0].evidence.phrases[0].starts, [1]);
  assert.deepEqual(store.query({ phrases: ["fox brown"] }).results, []);
  assert.deepEqual(store.query({ terms: ["123"] }).results, []);

  await store.close();
});

test("revisions must increase and unique live documents are capped", async () => {
  const path = dir("limits");
  const store = await DocumentStore.open({ directory: path, maxDocuments: 2 });

  await store.put("a", "alpha", 1);
  await store.put("b", "bravo", 1);
  await assert.rejects(store.put("c", "charlie", 1), /live documents/);
  await assert.rejects(store.put("a", "alpha newer", 1), /not newer/);
  await store.delete("a", 2);
  await store.put("c", "charlie", 3);
  assert.deepEqual(
    store.list().map((doc) => doc.id),
    ["b", "c"],
  );

  await store.close();
});

test("immutable segments recover writes after restart and support merge", async () => {
  const path = dir("segments");
  let store = await DocumentStore.open({ directory: path });

  await store.put("a", "alpha one", 1);
  await store.flush();
  const segment = JSON.parse(
    readFileSync(join(path, "segment-00000001.json"), "utf8"),
  );
  assert.deepEqual(segment.postings.alpha, [
    { id: "a", positions: [{ position: 0, start: 0, end: 5 }] },
  ]);
  assert.equal(segment.documents[0].body, "alpha one");
  await store.put("b", "beta one", 2);
  await store.flush();
  await store.put("a", "alpha two", 3);
  await store.delete("b", 4);
  await store.flush();

  await store.close();
  store = await DocumentStore.open({ directory: path });
  assert.equal(store.stats().bufferedOperations, 0);
  assert.deepEqual(
    store.query({ terms: ["alpha"] }).results.map((x) => x.revision),
    [3],
  );
  assert.deepEqual(store.query({ terms: ["beta"] }).results, []);

  const merge = await store.merge();
  assert.equal(merge.replacedSegmentIds.length, 3);
  await store.close();

  store = await DocumentStore.open({ directory: path });
  assert.deepEqual(store.manifest.segmentIds, [merge.segmentId]);
  assert.deepEqual(
    store.query({ terms: ["alpha"] }).results.map((x) => x.id),
    ["a"],
  );
  await store.close();
});

test("explicit snapshots compare against direct raw-document scans", async () => {
  const path = dir("snapshot");
  const model = new ReferenceModel();
  const store = await DocumentStore.open({ directory: path });

  const bodies = [
    "red fox jumps log",
    "blue fox and red dog",
    "red red fox",
    "fox red",
    "another unrelated document",
  ];
  bodies.forEach((body, index) => {
    model.put(`doc${index}`, body, 1);
  });
  for (const [id, body, revision] of bodies.map((body, index) => [
    `doc${index}`,
    body,
    1,
  ])) {
    await store.put(id, body, revision);
  }

  const snapshot = await store.snapshot();
  const expectedSequence = model.sequence;
  const expectedDocs = model.atSequence(expectedSequence);

  await store.put("doc0", "mutated red fox after snapshot", 2);
  await store.put("doc5", "fresh red fox document", 1);
  await store.delete("doc2", 2);
  model.put("doc0", "mutated red fox after snapshot", 2);
  model.put("doc5", "fresh red fox document", 1);
  model.delete("doc2", 2);
  await store.flush();

  const queries = [
    {},
    { terms: ["red"] },
    { terms: ["red", "fox"] },
    { phrases: ["red fox"] },
    { terms: ["fox"], phrases: ["red fox"] },
    { phrases: ["red", "red fox"] },
  ];

  for (const query of queries) {
    const expected = model.query(query, expectedDocs);
    const result = snapshot.query(query, { limit: 2 });
    let rows = result.results;
    let cursor = result.nextCursor;
    while (cursor) {
      const next = snapshot.queryPage(cursor);
      rows = rows.concat(next.results);
      cursor = next.nextCursor;
    }
    compareQueryResults(assert, rows, expected);
    assert.equal(result.sequence, expectedSequence);
  }

  const current = model.query({ terms: ["red", "fox"] });
  await snapshot.close();
  compareQueryResults(
    assert,
    store.query({ terms: ["red", "fox"] }).results,
    current,
  );
  await store.close();
});

test("closing an explicit snapshot waits to reclaim until its cursor completes", async () => {
  const path = dir("snapshot-cursor-lifecycle");
  const store = await DocumentStore.open({ directory: path });
  await store.put("a", "red fox one", 1);
  await store.flush();
  await store.put("b", "red fox two", 2);
  await store.flush();

  const snapshot = await store.snapshot();
  const first = snapshot.query({ terms: ["red", "fox"] }, { limit: 1 });
  assert.equal(store.stats().activeCursors, 1);
  await snapshot.close();
  assert.equal(store.stats().activeSnapshots, 1);

  const second = snapshot.queryPage(first.nextCursor);
  assert.deepEqual([first.results[0].id, second.results[0].id], ["a", "b"]);
  assert.equal(second.nextCursor, undefined);
  assert.equal(store.stats().activeSnapshots, 0);
  assert.equal(store.stats().activeCursors, 0);

  await store.close();
});

function windowsFor(result) {
  return result.results.map((row) => ({
    id: row.id,
    windows: row.evidence.near[0].windows,
  }));
}

test("near clauses consume distinct occurrences and honor order and total gap", async () => {
  const path = dir("near-semantics");
  const store = await DocumentStore.open({ directory: path });

  await store.put("single", "red blue", 1); // only one "red"
  await store.put("unordered", "blue red red", 2);
  await store.put("ordered", "red red blue", 3);
  await store.put("far", "red x red blue", 4);
  await store.put("tail", "noise noise noise red red blue", 5);

  const repeatOrdered = {
    near: [{ terms: ["red", "red"], maxGap: 1, ordered: true }],
  };
  const repeatAny = {
    near: [{ terms: ["red", "red"], maxGap: 1, ordered: false }],
  };
  assert.deepEqual(
    store.query(repeatAny).results.map((r) => r.id).sort(),
    ["far", "ordered", "tail", "unordered"],
  );
  assert.deepEqual(
    store.query(repeatOrdered).results.map((r) => r.id).sort(),
    ["far", "ordered", "tail", "unordered"],
  );

  // Order matters: ["red","red","blue"] vs ["blue","red","red"].
  const triOrdered = {
    near: [{ terms: ["red", "red", "blue"], maxGap: 2, ordered: true }],
  };
  const triUnordered = {
    near: [{ terms: ["red", "red", "blue"], maxGap: 2, ordered: false }],
  };
  assert.deepEqual(
    store.query(triOrdered).results.map((r) => r.id).sort(),
    ["far", "ordered", "tail"],
  );
  assert.deepEqual(
    store.query(triUnordered).results.map((r) => r.id).sort(),
    ["far", "ordered", "tail", "unordered"],
  );

  // maxGap counts every intervening nonselected token inside the window.
  // Unordered ignores direction: blue-before-red also matches.
  assert.deepEqual(
    store
      .query({ near: [{ terms: ["red", "blue"], maxGap: 1, ordered: false }] })
      .results.map((r) => r.id)
      .sort(),
    ["far", "ordered", "single", "tail", "unordered"],
  );
  assert.deepEqual(
    store
      .query({ near: [{ terms: ["red", "blue"], maxGap: 1, ordered: true }] })
      .results.map((r) => r.id)
      .sort(),
    ["far", "ordered", "single", "tail"],
  );
  // "far" only matches via its second red; the first red is two tokens away.
  assert.deepEqual(
    store
      .query({ near: [{ terms: ["red", "blue"], maxGap: 0, ordered: true }] })
      .results.map((r) => r.id)
      .sort(),
    ["far", "ordered", "single", "tail"],
  );

  // Valid combinations occurring later in the document are not skipped:
  // the match in "tail" only starts at token 3.
  assert.deepEqual(
    store
      .query({ near: [{ terms: ["red", "red", "blue"], maxGap: 0, ordered: true }] })
      .results.map((r) => r.id)
      .sort(),
    ["ordered", "tail"],
  );

  await store.close();
});

test("near evidence reports deterministic, self-supporting token windows", async () => {
  const path = dir("near-evidence");
  const store = await DocumentStore.open({ directory: path });
  await store.put("d", "x red a red blue y", 1);

  const ordered = store.query({
    near: [{ terms: ["red", "red", "blue"], maxGap: 2, ordered: true }],
  });
  assert.deepEqual(windowsFor(ordered), [
    { id: "d", windows: [{ start: 1, end: 4, positions: [1, 3, 4] }] },
  ]);

  // One minimal covering window [1..4]: red at 1, red at 3, blue at 4.
  // Position 5 ("y") cannot join a window since blue occurs only once.
  const unordered = store.query({
    near: [{ terms: ["red", "blue", "red"], maxGap: 2, ordered: false }],
  });
  assert.deepEqual(windowsFor(unordered), [
    {
      id: "d",
      windows: [{ start: 1, end: 4, positions: [1, 4, 3] }],
    },
  ]);

  // Every returned window provably satisfies its clause with distinct tokens.
  for (const row of unordered.results) {
    const bodyPositions = new Set(
      row.evidence.terms.red
        .concat(row.evidence.terms.blue)
        .map((hit) => hit.position),
    );
    for (const window of row.evidence.near[0].windows) {
      assert.equal(new Set(window.positions).size, window.positions.length);
      for (const position of window.positions)
        assert.ok(bodyPositions.has(position));
      const gap =
        window.end -
        window.start -
        (window.positions.length - 1);
      assert.ok(gap <= 2);
    }
  }

  await store.close();
});

test("near clauses combine with term intersections and consecutive phrases", async () => {
  const path = dir("near-combined");
  const store = await DocumentStore.open({ directory: path });
  await store.put("a", "red red blue fox", 1);
  await store.put("b", "red red blue hound", 2);
  await store.put("c", "red red green fox", 3);

  const query = {
    terms: ["fox"],
    phrases: ["red red"],
    near: [{ terms: ["red", "blue"], maxGap: 1, ordered: true }],
  };
  assert.deepEqual(store.query(query).results.map((r) => r.id), ["a"]);

  await store.close();
});

test("store-level cursor keeps paging against its original snapshot through mutations and merges", async () => {
  const path = dir("near-pagination");
  const store = await DocumentStore.open({ directory: path });
  for (let i = 0; i < 7; i++) {
    await store.put(`doc-${i}`, "red red blue tail", 1);
    if (i % 2 === 0) await store.flush();
  }

  const query = {
    near: [{ terms: ["red", "blue"], maxGap: 2, ordered: true }],
  };
  const first = store.query(query, { limit: 2 });
  assert.deepEqual(first.results.map((r) => r.id), ["doc-0", "doc-1"]);

  // Mutate, delete, flush and merge while the cursor remains outstanding.
  await store.put("doc-0", "red green blue rewritten", 2);
  await store.put("doc-1", "red red blue rewritten", 2);
  await store.delete("doc-2", 2);
  await store.put("doc-8", "red red blue brand new", 1);
  await store.flush();
  await store.merge();
  await store.reclaimSegments();

  const pages = [first.results];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = store.queryNext(cursor);
    pages.push(next.results);
    cursor = next.nextCursor;
  }
  const ids = pages.flat().map((r) => r.id);
  assert.deepEqual(ids, [
    "doc-0",
    "doc-1",
    "doc-2",
    "doc-3",
    "doc-4",
    "doc-5",
    "doc-6",
  ]);
  // Evidence still reflects the first-query snapshot revision.
  assert.deepEqual(
    [...new Set(pages.flat().map((r) => r.revision))],
    [1],
  );
  for (const row of pages.flat()) {
    assert.equal(row.evidence.near[0].windows.length > 0, true);
  }
  assert.equal(store.stats().activeCursors, 0);

  await store.close();
});

test("explicit snapshot paging with near clauses is stable under concurrent revisions", async () => {
  const path = dir("near-snapshot-paging");
  const model = new ReferenceModel();
  const store = await DocumentStore.open({ directory: path });
  const bodies = [
    "red red blue one",
    "x red red blue two",
    "red x red blue three",
    "red red x blue four",
    "red red blue five",
    "red red blue six",
  ];
  bodies.forEach((body, i) => model.put(`d${i}`, body, 1));
  for (const [i, body] of bodies.entries())
    await store.put(`d${i}`, body, 1);

  const snapshot = await store.snapshot();
  const expectedDocs = model.atSequence(model.sequence);
  const query = {
    near: [{ terms: ["red", "red", "blue"], maxGap: 1, ordered: true }],
  };
  const first = snapshot.query(query, { limit: 2 });

  let revision = 1;
  for (const i of [0, 2, 4]) {
    revision++;
    await store.put(`d${i}`, "blue red red rewritten", revision);
    await store.delete(`d${(i + 1) % 6}`, ++revision);
  }
  await store.flush();
  await store.merge();

  let rows = first.results;
  let cursor = first.nextCursor;
  while (cursor) {
    const next = snapshot.queryPage(cursor);
    rows = rows.concat(next.results);
    cursor = next.nextCursor;
  }
  compareQueryResults(assert, rows, model.query(query, expectedDocs));
  await snapshot.close();

  await store.close();
});


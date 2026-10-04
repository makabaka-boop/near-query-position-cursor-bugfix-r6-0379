import test from "node:test";
import assert from "node:assert/strict";
import { DocumentStore } from "../src/index.js";
import { cleanup, makeTempDir } from "./reference.js";

const dirs = [];
test.after(() => cleanup(dirs));

function query(store, near, extra = {}) {
  return store.query({ near, ...extra });
}

test("repeated query terms consume distinct token occurrences", async () => {
  const path = makeTempDir("near-repeat");
  dirs.push(path);
  const store = await DocumentStore.open({ directory: path });

  await store.put("one", "red fox", 1); // single red: cannot satisfy red red blue
  await store.put("two", "red x red blue", 2); // reds at 0,2 blue at 3: gap 1
  await store.put("three", "red red blue", 3); // tight ordered
  await store.put(
    "four",
    "red x x x x red red blue tail",
    4,
  ); // valid only via later occurrences

  const ordered = query(store, [
    { terms: ["red", "red", "blue"], maxGap: 1, ordered: true },
  ]);
  assert.deepEqual(ordered.results.map((r) => r.id).sort(), [
    "four",
    "three",
    "two",
  ]);

  const two = ordered.results.find((r) => r.id === "two");
  assert.deepEqual(two.evidence.near[0].windows, [
    { start: 0, end: 3, positions: [0, 2, 3] },
  ]);

  // A single occurrence of a repeated term never matches.
  assert.deepEqual(
    query(store, [
      { terms: ["red", "red"], maxGap: 16, ordered: false },
    ]).results.map((r) => r.id),
    ["four", "three", "two"],
  );

  await store.close();
});

test("ordered clauses require the supplied order; unordered require the multiset", async () => {
  const path = makeTempDir("near-order");
  dirs.push(path);
  const store = await DocumentStore.open({ directory: path });

  await store.put("rb", "red blue", 1);
  await store.put("br", "blue red", 2);
  await store.put("tight", "x red blue x", 3);

  const orderedRB = query(store, [
    { terms: ["red", "blue"], maxGap: 0, ordered: true },
  ]);
  assert.deepEqual(orderedRB.results.map((r) => r.id).sort(), ["rb", "tight"]);

  const orderedBR = query(store, [
    { terms: ["blue", "red"], maxGap: 0, ordered: true },
  ]);
  assert.deepEqual(orderedBR.results.map((r) => r.id), ["br"]);

  // Unordered ignores direction.
  const unordered = query(store, [
    { terms: ["blue", "red"], maxGap: 0, ordered: false },
  ]);
  assert.deepEqual(unordered.results.map((r) => r.id).sort(), [
    "br",
    "rb",
    "tight",
  ]);

  await store.close();
});

test("maxGap counts total intervening nonselected tokens", async () => {
  const path = makeTempDir("near-gap");
  dirs.push(path);
  const store = await DocumentStore.open({ directory: path });

  await store.put("g0", "red blue", 1);
  await store.put("g1", "red x blue", 2);
  await store.put("g2", "red x x blue", 3);

  assert.deepEqual(
    query(store, [{ terms: ["red", "blue"], maxGap: 0, ordered: true }])
      .results.map((r) => r.id),
    ["g0"],
  );
  assert.deepEqual(
    query(store, [{ terms: ["red", "blue"], maxGap: 1, ordered: true }])
      .results.map((r) => r.id).sort(),
    ["g0", "g1"],
  );
  assert.deepEqual(
    query(store, [{ terms: ["red", "blue"], maxGap: 2, ordered: true }])
      .results.map((r) => r.id).sort(),
    ["g0", "g1", "g2"],
  );

  // Extra occurrences inside a covering window count as nonselected tokens:
  // the only minimal {red,blue} window starts at the second red adjacent to
  // blue, yielding a single deterministic window.
  const extraPath = makeTempDir("near-extra-gap");
  dirs.push(extraPath);
  const extraStore = await DocumentStore.open({ directory: extraPath });
  await extraStore.put("e", "red red blue", 1);
  const extra = query(extraStore, [
    { terms: ["red", "blue"], maxGap: 0, ordered: false },
  ]);
  assert.deepEqual(extra.results[0].evidence.near[0].windows, [
    { start: 1, end: 2, positions: [1, 2] },
  ]);
  await extraStore.close();
  await store.close();
});

test("multiple minimal windows are reported with deterministic positions", async () => {
  const path = makeTempDir("near-windows");
  dirs.push(path);
  const store = await DocumentStore.open({ directory: path });

  await store.put("d", "red blue x x red blue", 1);
  const result = query(store, [
    { terms: ["red", "blue"], maxGap: 0, ordered: false },
  ]);
  assert.deepEqual(result.results[0].evidence.near[0].windows, [
    { start: 0, end: 1, positions: [0, 1] },
    { start: 4, end: 5, positions: [4, 5] },
  ]);

  await store.close();
});

test("near clauses combine with term intersection and consecutive phrases on the same revision", async () => {
  const path = makeTempDir("near-combine");
  dirs.push(path);
  const store = await DocumentStore.open({ directory: path });

  await store.put("a", "quick red fox jumps", 1);
  await store.put("b", "quick red x fox jumps", 2);
  await store.put("c", "slow red fox jumps", 3); // near + phrase hit, missing term
  await store.put("d", "quick red box fox", 4); // term hit, phrase & near gap fail

  const result = store.query({
    terms: ["quick"],
    phrases: ["red fox"],
    near: [{ terms: ["red", "fox"], maxGap: 0, ordered: true }],
  });
  assert.deepEqual(result.results.map((r) => r.id), ["a"]);
  const evidence = result.results[0].evidence;
  assert.deepEqual(evidence.phrases[0].starts, [1]);
  assert.deepEqual(evidence.near[0].windows, [
    { start: 1, end: 2, positions: [1, 2] },
  ]);
  // Near term occurrences are included as supporting evidence.
  assert.deepEqual(
    evidence.terms.red.map((h) => h.position),
    [1],
  );
  assert.deepEqual(
    evidence.terms.fox.map((h) => h.position),
    [2],
  );

  // A later revision that breaks the phrase/near conjunction drops the doc.
  await store.put("a", "quick red box fox", 2);
  // Without the term intersection, c ("slow red fox jumps") still satisfies
  // the phrase and the proximity clause.
  assert.deepEqual(
    store
      .query({
        phrases: ["red fox"],
        near: [{ terms: ["red", "fox"], maxGap: 0, ordered: true }],
      })
      .results.map((r) => r.id),
    ["c"],
  );
  // With all three constraints nothing remains: a lost the phrase, d never had
  // it, c lacks "quick".
  assert.deepEqual(
    store
      .query({
        terms: ["quick"],
        phrases: ["red fox"],
        near: [{ terms: ["red", "fox"], maxGap: 0, ordered: true }],
      })
      .results.map((r) => r.id),
    [],
  );

  await store.close();
});

test("paging keeps the first query snapshot and conditions through update/delete/merge", async () => {
  const path = makeTempDir("near-paging");
  dirs.push(path);
  const store = await DocumentStore.open({ directory: path });

  for (let i = 0; i < 6; i++) {
    await store.put(`doc${i}`, `red fox text ${i}`, 1);
  }
  await store.flush();

  // Auto-pinned cursor from store.query must survive middle pages while the
  // live store changes underneath it.
  const first = store.query(
    { near: [{ terms: ["red", "fox"], maxGap: 0, ordered: true }] },
    { limit: 2 },
  );
  const snapshotId = first.snapshotId;
  const queryJson = JSON.stringify(first.query);

  // Mutate, tombstone and merge before advancing the cursor.
  await store.put("doc1", "completely different content now", 2);
  await store.delete("doc2", 2);
  await store.put("doc6", "red fox brand new document", 1);
  await store.put("doc7", "red fox another new document", 1);
  await store.flush();
  await store.merge();
  await store.put("doc0", "red fox rewritten after first page", 3);

  const collected = [...first.results];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = store.queryNext(cursor);
    assert.equal(next.snapshotId, snapshotId);
    assert.equal(JSON.stringify(next.query), queryJson);
    assert.equal(next.sequence, first.sequence);
    collected.push(...next.results);
    cursor = next.nextCursor;
  }

  // Exactly the original six docs at revision 1, in stable docId order.
  assert.deepEqual(
    collected.map((r) => r.id),
    ["doc0", "doc1", "doc2", "doc3", "doc4", "doc5"],
  );
  assert.ok(collected.every((r) => r.revision === 1));
  // Evidence comes from the snapshot revision too.
  assert.deepEqual(
    collected[0].evidence.near[0].windows,
    [{ start: 0, end: 1, positions: [0, 1] }],
  );

  assert.equal(store.stats().activeCursors, 0);
  assert.equal(store.stats().activeSnapshots, 0);

  // The live store reflects every mutation.
  const live = store.query({
    near: [{ terms: ["red", "fox"], maxGap: 0, ordered: true }],
  });
  assert.deepEqual(live.results.map((r) => r.id).sort(), [
    "doc0",
    "doc3",
    "doc4",
    "doc5",
    "doc6",
    "doc7",
  ]);

  await store.close();
});

test("explicit snapshot pages repeat no rows and lose none across merge", async () => {
  const path = makeTempDir("near-snapshot-paging");
  dirs.push(path);
  const store = await DocumentStore.open({ directory: path });

  for (let i = 0; i < 5; i++) {
    await store.put(`d${i}`, `red fox ${i}`, 1);
    await store.flush();
  }

  const snapshot = await store.snapshot();
  const first = snapshot.query(
    {
      terms: ["red"],
      near: [{ terms: ["red", "fox"], maxGap: 1, ordered: false }],
    },
    { limit: 2 },
  );

  await store.put("d0", "red fox updated body", 2);
  await store.delete("d3", 2);
  await store.merge();
  await store.put("z9", "red fox late arrival", 1);
  await store.flush();

  let rows = [...first.results];
  let cursor = first.nextCursor;
  while (cursor) {
    const consumed = cursor;
    const next = snapshot.queryPage(cursor);
    assert.throws(() => snapshot.queryPage(consumed), /already advanced/);
    rows.push(...next.results);
    cursor = next.nextCursor;
  }
  assert.deepEqual(
    rows.map((r) => r.id),
    ["d0", "d1", "d2", "d3", "d4"],
  );
  assert.ok(rows.every((r) => r.revision === 1));

  await snapshot.close();
  await store.close();
});

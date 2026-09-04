import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  addEntries,
  MAPPING_PATH,
  parseMapping,
  serializeMapping,
} from "../drift/mapping";
import {
  classifyDrift,
  isDeclaredSubsetOfLive,
  type MappedObservation,
} from "../drift/scan";

const ENTRY_A = { path: "ops/a.yaml", kind: "Zone", name: "a" };
const ENTRY_B = { path: "ops/b.yaml", kind: "Zone", name: "b" };

function obs(overrides: Partial<MappedObservation> & { name: string }) {
  return {
    entry: {
      path: `ops/${overrides.name}.yaml`,
      kind: "Zone",
      name: overrides.name,
    },
    ...overrides,
  } as MappedObservation;
}

suite("drift mapping — explicit, visible, hand-editable", () => {
  test("round-trips through a stable, human-readable JSON file", () => {
    const mapping = { profile: "ada.a.airdr.es", manifests: [ENTRY_A] };
    const text = serializeMapping(mapping);
    assert.ok(text.endsWith("\n"));
    assert.match(text, /"profile": "ada\.a\.airdr\.es"/);
    const parsed = parseMapping(text);
    assert.ok("mapping" in parsed);
    assert.deepStrictEqual(parsed.mapping, mapping);
  });

  test("a malformed mapping reports WHAT is wrong, never guesses", () => {
    for (const [text, message] of [
      ["not json", /not valid JSON/],
      ["[]", /must be a JSON object/],
      ["{}", /"profile"/],
      ['{"profile": "x"}', /"manifests"/],
      ['{"profile": "x", "manifests": [{"path": "a"}]}', /missing "kind"/],
    ] as const) {
      const parsed = parseMapping(text);
      assert.ok("error" in parsed, `expected error for ${text}`);
      assert.match(parsed.error, message);
    }
  });

  test("nothing is inferred from filenames anywhere in the drift modules", () => {
    // The mapping is the ONLY source of the file → resource relation.
    // Guard the property at the source level: no glob/find-files based
    // discovery may exist in the drift implementation.
    const driftDir = path.resolve(__dirname, "..", "..", "src", "drift");
    for (const file of fs.readdirSync(driftDir)) {
      const content = fs.readFileSync(path.join(driftDir, file), "utf8");
      for (const needle of ["findFiles", "glob", "basename("]) {
        assert.ok(
          !content.includes(needle),
          `${file} must not discover manifests by filename (${needle})`,
        );
      }
    }
  });

  test("re-adding a resource re-points it; new resources append", () => {
    const mapping = { profile: "ada.a.airdr.es", manifests: [ENTRY_A] };
    const moved = { ...ENTRY_A, path: "ops/moved.yaml" };
    const next = addEntries(mapping, [moved, ENTRY_B]);
    assert.deepStrictEqual(next.manifests, [moved, ENTRY_B]);
    // Immutable input:
    assert.deepStrictEqual(mapping.manifests, [ENTRY_A]);
  });

  test("the mapping lives at a visible, committed workspace path", () => {
    assert.strictEqual(MAPPING_PATH, ".airdress/manifests.json");
  });
});

suite("declared-subset comparison", () => {
  test("live-only fields (status, server defaults) are NOT drift", () => {
    const declared = { kind: "Zone", spec: { target: "1.2.3.4" } };
    const live = {
      kind: "Zone",
      spec: { target: "1.2.3.4", ttl: 300 },
      status: { state: "Ready" },
    };
    assert.strictEqual(isDeclaredSubsetOfLive(declared, live), true);
  });

  test("a declared value the live state contradicts IS drift", () => {
    assert.strictEqual(
      isDeclaredSubsetOfLive(
        { spec: { target: "1.2.3.4" } },
        { spec: { target: "5.6.7.8" } },
      ),
      false,
    );
    assert.strictEqual(
      isDeclaredSubsetOfLive({ spec: { a: [1, 2] } }, { spec: { a: [1] } }),
      false,
    );
  });
});

suite("workspace drift scan — four classes, nothing dropped", () => {
  test("all four classifications are produced from a mixed workspace", () => {
    const doc = { kind: "Zone", spec: { target: "1.2.3.4" } };
    const rows = classifyDrift(
      [
        obs({ name: "sync", localDoc: doc, liveDoc: { ...doc, status: {} } }),
        obs({
          name: "drift",
          localDoc: doc,
          liveDoc: { kind: "Zone", spec: { target: "9.9.9.9" } },
        }),
        obs({ name: "gone", localDoc: doc, liveDoc: undefined }),
      ],
      [
        { kind: "Zone", name: "sync" },
        { kind: "Zone", name: "drift" },
        { kind: "Zone", name: "stray" },
      ],
    );
    assert.deepStrictEqual(
      rows.map((r) => `${r.name}:${r.classification}`),
      ["sync:in-sync", "drift:drifted", "gone:missing", "stray:unmanaged"],
    );
  });

  test("NOTHING is silently dropped: rows = mapped entries + unmapped live resources", () => {
    const observations = [
      obs({ name: "a", localDoc: {}, liveDoc: {} }),
      obs({ name: "b", localDoc: {}, liveDoc: undefined }),
      obs({ name: "c", localError: "ENOENT", liveDoc: {} }),
    ];
    const live = [
      { kind: "Zone", name: "a" },
      { kind: "Zone", name: "c" },
      { kind: "Zone", name: "x" },
      { kind: "Zone", name: "y" },
    ];
    const rows = classifyDrift(observations, live);
    assert.strictEqual(rows.length, observations.length + 2);
    const names = rows.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ["a", "b", "c", "x", "y"]);
  });

  test("an unreadable mapped file classifies as drifted-with-reason — never as in-sync", () => {
    const [row] = classifyDrift(
      [obs({ name: "broken", localError: "unexpected token", liveDoc: {} })],
      [],
    );
    assert.strictEqual(row.classification, "drifted");
    assert.match(String(row.detail), /cannot be compared/);
  });

  test("no auto-remediation exists on any drift code path", () => {
    // The scan reports and diffs; applying is the ordinary apply
    // command with its own confirm. Enforced structurally: the drift
    // modules contain no mutating HTTP verb and no apply endpoint.
    const driftDir = path.resolve(__dirname, "..", "..", "src", "drift");
    for (const file of fs.readdirSync(driftDir)) {
      const content = fs.readFileSync(path.join(driftDir, file), "utf8");
      for (const needle of [
        "/v1/apply",
        '"POST"',
        '"DELETE"',
        '"PUT"',
        '"PATCH"',
        "applyManifest",
      ]) {
        assert.ok(
          !content.includes(needle),
          `${file} must not contain ${needle} — drift is reported, never remediated`,
        );
      }
    }
  });
});

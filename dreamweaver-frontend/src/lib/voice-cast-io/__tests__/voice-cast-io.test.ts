import { describe, expect, it } from "bun:test";

import {
  parseVoiceCast,
  planVoiceCastImport,
  serializeVoiceCast,
  stringifyVoiceCast,
  suggestVoiceCastWith,
} from "@/lib/voice-cast-io";

describe("serializeVoiceCast", () => {
  it("returns an empty entries list when no packs have a valid voice", () => {
    const payload = serializeVoiceCast(
      [{ name: "MAYA" }, { name: "DANIEL", voice: "" }, {}],
      "2026-04-19T00:00:00.000Z",
    );
    expect(payload.kind).toBe("voice-cast");
    expect(payload.schemaVersion).toBe(1);
    expect(payload.exportedAt).toBe("2026-04-19T00:00:00.000Z");
    expect(payload.entries).toEqual([]);
  });

  it("keeps only packs with an allowed voice", () => {
    const payload = serializeVoiceCast([
      { name: "MAYA", voice: "nova" },
      { name: "DANIEL", voice: "not-a-voice" },
      { name: "KIRA", voice: "onyx", sourceCharacterId: "KIRA" },
    ]);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toEqual({ name: "MAYA", voice: "nova" });
    expect(payload.entries[1]).toEqual({
      name: "KIRA",
      sourceCharacterId: "KIRA",
      voice: "onyx",
    });
  });

  it("normalizes voice casing", () => {
    const payload = serializeVoiceCast([{ name: "MAYA", voice: "NOVA" }]);
    expect(payload.entries[0].voice).toBe("nova");
  });

  it("skips packs without a name", () => {
    const payload = serializeVoiceCast([{ voice: "nova" }]);
    expect(payload.entries).toEqual([]);
  });

  it("stringifies to valid JSON", () => {
    const payload = serializeVoiceCast([{ name: "MAYA", voice: "nova" }]);
    const json = stringifyVoiceCast(payload);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("parseVoiceCast", () => {
  it("fails on empty input", () => {
    expect(parseVoiceCast("").error).toBe("empty input");
    expect(parseVoiceCast("   ").error).toBe("empty input");
  });

  it("fails on invalid JSON", () => {
    expect(parseVoiceCast("{oops").error).toContain("JSON");
  });

  it("parses a full envelope", () => {
    const input = JSON.stringify({
      kind: "voice-cast",
      schemaVersion: 1,
      exportedAt: "2026-04-19T00:00:00.000Z",
      entries: [{ name: "MAYA", voice: "nova" }],
    });
    const { payload, droppedCount, error } = parseVoiceCast(input);
    expect(error).toBeUndefined();
    expect(droppedCount).toBe(0);
    expect(payload?.entries).toEqual([{ name: "MAYA", voice: "nova" }]);
    expect(payload?.exportedAt).toBe("2026-04-19T00:00:00.000Z");
  });

  it("parses a bare array", () => {
    const input = JSON.stringify([
      { name: "MAYA", voice: "nova" },
      { name: "DANIEL", voice: "onyx", sourceCharacterId: "DANIEL" },
    ]);
    const { payload, error } = parseVoiceCast(input);
    expect(error).toBeUndefined();
    expect(payload?.entries).toHaveLength(2);
    expect(payload?.entries[1].sourceCharacterId).toBe("DANIEL");
  });

  it("rejects wrong kind", () => {
    const input = JSON.stringify({ kind: "something-else", entries: [] });
    expect(parseVoiceCast(input).error).toContain("unexpected kind");
  });

  it("rejects non-object non-array JSON", () => {
    expect(parseVoiceCast("42").error).toContain("expected JSON");
    expect(parseVoiceCast('"hi"').error).toContain("expected JSON");
  });

  it("drops invalid entries and counts them", () => {
    const input = JSON.stringify([
      { name: "MAYA", voice: "nova" }, // ok
      { name: "BAD", voice: "xxx" }, // invalid voice → dropped
      { voice: "nova" }, // missing name → dropped
      null, // not-an-object → dropped
    ]);
    const { payload, droppedCount } = parseVoiceCast(input);
    expect(payload?.entries).toHaveLength(1);
    expect(droppedCount).toBe(3);
  });

  it("is case-insensitive on voice names", () => {
    const input = JSON.stringify([{ name: "MAYA", voice: "NOVA" }]);
    const { payload } = parseVoiceCast(input);
    expect(payload?.entries[0].voice).toBe("nova");
  });
});

describe("suggestVoiceCastWith", () => {
  const fakeInferrer = (dnaJson: string) => {
    // Deterministic stub: DNA containing the word "female" → feminine,
    // "male" → masculine (checked last to let "female" win its match),
    // otherwise null.
    if (!dnaJson) return null;
    const lower = dnaJson.toLowerCase();
    if (lower.includes("female")) return "feminine" as const;
    if (lower.includes("male")) return "masculine" as const;
    if (lower.includes("androgynous")) return "neutral" as const;
    return null;
  };

  it("skips packs whose voice is already set", () => {
    const result = suggestVoiceCastWith(
      [
        {
          name: "MAYA",
          voice: "nova",
          dnaJson: JSON.stringify({ gender: "female" }),
        },
      ],
      fakeInferrer,
    );
    expect(result.entries).toEqual([]);
  });

  it("includes already-cast packs when overwrite is on", () => {
    const result = suggestVoiceCastWith(
      [
        {
          name: "MAYA",
          voice: "nova",
          dnaJson: JSON.stringify({ gender: "female" }),
        },
      ],
      fakeInferrer,
      { overwrite: true },
    );
    expect(result.entries).toHaveLength(1);
  });

  it("rotates through masculine + feminine pools", () => {
    const result = suggestVoiceCastWith(
      [
        { name: "A", dnaJson: '"female"' },
        { name: "B", dnaJson: '"female"' },
        { name: "C", dnaJson: '"female"' },
        { name: "X", dnaJson: '"male"' },
        { name: "Y", dnaJson: '"male"' },
      ],
      fakeInferrer,
    );
    const voices = result.entries.map((e) => e.voice);
    // Feminine trio: nova, shimmer, nova (rotating pool of 2).
    expect(voices.slice(0, 3)).toEqual(["nova", "shimmer", "nova"]);
    // Masculine pair: onyx, echo.
    expect(voices.slice(3)).toEqual(["onyx", "echo"]);
  });

  it("falls back to the neutral default when DNA has no gender signal", () => {
    const result = suggestVoiceCastWith(
      [{ name: "MYSTERY", dnaJson: '"nobody knows"' }],
      fakeInferrer,
    );
    expect(result.entries[0].voice).toBe("alloy");
  });

  it("honors the neutralDefault option", () => {
    const result = suggestVoiceCastWith(
      [{ name: "MYSTERY" }],
      fakeInferrer,
      { neutralDefault: "fable" },
    );
    expect(result.entries[0].voice).toBe("fable");
  });

  it("carries sourceCharacterId through when present", () => {
    const result = suggestVoiceCastWith(
      [
        {
          name: "MAYA",
          sourceCharacterId: "maya_internal_id",
          dnaJson: '"female"',
        },
      ],
      fakeInferrer,
    );
    expect(result.entries[0].sourceCharacterId).toBe("maya_internal_id");
  });

  it("skips packs with no name", () => {
    const result = suggestVoiceCastWith(
      [{ dnaJson: '"female"' }],
      fakeInferrer,
    );
    expect(result.entries).toEqual([]);
  });
});

describe("planVoiceCastImport", () => {
  it("matches by sourceCharacterId first", () => {
    const result = planVoiceCastImport(
      [
        {
          name: "Different Name",
          sourceCharacterId: "MAYA",
          voice: "nova",
        },
      ],
      [
        { packId: "p1", name: "Whatever", sourceCharacterId: "MAYA" },
        { packId: "p2", name: "Different Name" },
      ],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].packId).toBe("p1");
    expect(result.matches[0].matchedBy).toBe("sourceCharacterId");
    expect(result.unmatched).toEqual([]);
  });

  it("falls back to name match when sourceCharacterId doesn't hit", () => {
    const result = planVoiceCastImport(
      [{ name: "MAYA", voice: "nova" }],
      [{ packId: "p1", name: "Maya" }],
    );
    expect(result.matches[0].packId).toBe("p1");
    expect(result.matches[0].matchedBy).toBe("name");
  });

  it("reports unmatched entries", () => {
    const result = planVoiceCastImport(
      [{ name: "KIRA", voice: "onyx" }],
      [{ packId: "p1", name: "MAYA" }],
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0].entry.name).toBe("KIRA");
  });

  it("matching is case-insensitive", () => {
    const result = planVoiceCastImport(
      [{ name: "maya", voice: "nova" }],
      [{ packId: "p1", name: "MAYA" }],
    );
    expect(result.matches).toHaveLength(1);
  });

  it("skips packs without packId", () => {
    const result = planVoiceCastImport(
      [{ name: "MAYA", voice: "nova" }],
      [{ packId: "", name: "MAYA" }],
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
  });
});

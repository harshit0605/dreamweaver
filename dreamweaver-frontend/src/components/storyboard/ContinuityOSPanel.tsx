"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

interface VoiceCloneRow {
  _id: string;
  name: string;
  description: string | null;
  elevenlabsVoiceId: string;
  previewUrl: string | null;
  locale: string | null;
}

import type { ConstraintBundle, IdentityReferenceRecord, PortraitView } from "@/app/storyboard/types";
import {
  orderPortraitsCanonically,
  PORTRAIT_VIEW_OPTIONS,
  portraitSetStatus,
} from "@/lib/identity-portraits";
import { mutationRef, queryRef } from "@/lib/convexRefs";
import {
  parseVoiceCast,
  planVoiceCastImport,
  serializeVoiceCast,
  stringifyVoiceCast,
  suggestVoiceCast,
  type MatchablePack,
} from "@/lib/voice-cast-io";

type ViolationStatus = "acknowledged" | "resolved";

type IdentityPortraitCallbacks = {
  addPortrait: (input: {
    storyboardId: string;
    ownerPackId: string;
    portraitView: PortraitView;
    sourceUrl: string;
    notes?: string;
  }) => Promise<void>;
  removePortrait: (input: { referenceId: string }) => Promise<void>;
};

type ContinuityOSPanelProps = {
  bundle: ConstraintBundle | null;
  onDetectContradictions: () => Promise<void>;
  onRunShotValidators?: () => Promise<void>;
  onResolveViolation?: (violationId: string, status: ViolationStatus) => Promise<void>;
  onPublishIdentityPack?: (packId: string, publish: boolean) => Promise<void>;
  /** M6 — update the per-character TTS voice assignment. Empty string
   *  clears the assignment (audio batch falls back to its default). */
  onSetIdentityPackVoice?: (packId: string, voice: string) => Promise<void>;
  // Portrait surface wiring (#7). Both need to be provided together for the
  // "Reference portraits" section to show its edit affordances; if either is
  // missing the section renders in read-only mode.
  storyboardId?: string;
  identityPortraitCallbacks?: IdentityPortraitCallbacks;
};

type TabKey = "identity" | "constraints" | "violations";

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const asBool = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

export function ContinuityOSPanel({
  bundle,
  onDetectContradictions,
  onRunShotValidators,
  onResolveViolation,
  onPublishIdentityPack,
  onSetIdentityPackVoice,
  storyboardId,
  identityPortraitCallbacks,
}: ContinuityOSPanelProps) {
  const identityPacks = bundle?.identityPacks ?? [];
  const globalConstraints = bundle?.globalConstraints ?? [];
  const violations = bundle?.continuityViolations ?? [];

  const [tab, setTab] = useState<TabKey>(
    violations.length > 0 ? "violations" : "identity",
  );

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/95 text-zinc-100 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-zinc-400">Continuity OS</p>
          <h3 className="mt-1 text-sm font-semibold">DNA + Constraints</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded bg-zinc-800 px-2 py-1 text-xs"
            onClick={() => void onDetectContradictions()}
          >
            Detect
          </button>
          <button
            type="button"
            className="rounded bg-zinc-800 px-2 py-1 text-xs disabled:opacity-50"
            onClick={() => onRunShotValidators && void onRunShotValidators()}
            disabled={!onRunShotValidators}
          >
            Validate shots
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <Stat label="Identity Packs" value={String(identityPacks.length)} />
        <Stat label="Constraints" value={String(globalConstraints.length)} />
        <Stat label="Open Violations" value={String(violations.length)} />
      </div>

      <div className="mt-3 flex gap-1 border-b border-zinc-800">
        <TabButton active={tab === "identity"} onClick={() => setTab("identity")}>
          Identity ({identityPacks.length})
        </TabButton>
        <TabButton active={tab === "constraints"} onClick={() => setTab("constraints")}>
          Constraints ({globalConstraints.length})
        </TabButton>
        <TabButton active={tab === "violations"} onClick={() => setTab("violations")}>
          Violations ({violations.length})
        </TabButton>
      </div>

      <div className="mt-3 max-h-80 overflow-y-auto space-y-2">
        {tab === "identity" ? (
          <IdentityPacksView
            packs={identityPacks}
            onPublishIdentityPack={onPublishIdentityPack}
            onSetIdentityPackVoice={onSetIdentityPackVoice}
            storyboardId={storyboardId}
            identityPortraitCallbacks={identityPortraitCallbacks}
          />
        ) : null}
        {tab === "constraints" ? (
          <ConstraintsView constraints={globalConstraints} />
        ) : null}
        {tab === "violations" ? (
          <ViolationsView violations={violations} onResolveViolation={onResolveViolation} />
        ) : null}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-800 p-2">
      <p className="text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-zinc-100 font-medium">{value}</p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-2 py-1 text-[11px] transition-colors " +
        (active
          ? "border-b-2 border-emerald-400 text-zinc-100"
          : "text-zinc-500 hover:text-zinc-300")
      }
    >
      {children}
    </button>
  );
}

function IdentityPacksView({
  packs,
  onPublishIdentityPack,
  onSetIdentityPackVoice,
  storyboardId,
  identityPortraitCallbacks,
}: {
  packs: Array<Record<string, unknown>>;
  onPublishIdentityPack?: (packId: string, publish: boolean) => Promise<void>;
  onSetIdentityPackVoice?: (packId: string, voice: string) => Promise<void>;
  storyboardId?: string;
  identityPortraitCallbacks?: IdentityPortraitCallbacks;
}) {
  // Voice clones are producer-scoped (not per-storyboard), so we fetch
  // them once here and pass the list down to every row. Skipped when
  // storyboardId is missing because the rows won't render their clone
  // picker in that case anyway.
  const voiceClones = useQuery(
    queryRef("voiceClones:listVoiceClones"),
    storyboardId ? {} : "skip",
  ) as VoiceCloneRow[] | undefined;
  const setPackVoiceClone = useMutation(
    mutationRef("voiceClones:setPackVoiceClone"),
  );
  const handleSetPackVoiceClone = useMemo(
    () =>
      async (packId: string, voiceCloneId: string | null) => {
        if (!storyboardId) return;
        await setPackVoiceClone({
          storyboardId: storyboardId as never,
          packId,
          voiceCloneId:
            voiceCloneId === null ? null : (voiceCloneId as never),
        });
      },
    [setPackVoiceClone, storyboardId],
  );

  if (packs.length === 0) {
    return <p className="text-[11px] text-zinc-500">No identity packs yet.</p>;
  }
  return (
    <>
      {onSetIdentityPackVoice ? (
        <VoiceCastIO
          packs={packs}
          onSetIdentityPackVoice={onSetIdentityPackVoice}
        />
      ) : null}
      {packs.slice(0, 12).map((pack, index) => (
        <IdentityPackRow
          key={asString(pack.packId, `pack_${index}`)}
          pack={pack}
          onPublishIdentityPack={onPublishIdentityPack}
          onSetIdentityPackVoice={onSetIdentityPackVoice}
          voiceClones={voiceClones}
          onSetPackVoiceClone={
            storyboardId ? handleSetPackVoiceClone : undefined
          }
          storyboardId={storyboardId}
          identityPortraitCallbacks={identityPortraitCallbacks}
        />
      ))}
    </>
  );
}

/**
 * M6 Voice #3 — export / import the voice cast as JSON so producers can
 * transplant assignments between storyboards. Export copies the current
 * `{ packName, sourceCharacterId?, voice }` list to the clipboard;
 * import accepts a pasted JSON payload and applies each entry via
 * onSetIdentityPackVoice after matching packs by sourceCharacterId or
 * name (case-insensitive).
 *
 * Intentionally light on polish — a producer tool, not an end-user
 * feature. Inline textarea + status line. Hidden entirely when the
 * caller didn't provide `onSetIdentityPackVoice`.
 */
function VoiceCastIO({
  packs,
  onSetIdentityPackVoice,
}: {
  packs: Array<Record<string, unknown>>;
  onSetIdentityPackVoice: (packId: string, voice: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"idle" | "import">("idle");
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<
    "info" | "error" | "success"
  >("info");
  const [busy, setBusy] = useState(false);

  const castCount = useMemo(() => {
    const payload = serializeVoiceCast(
      packs.map((p) => ({
        name: p.name,
        sourceCharacterId: p.sourceCharacterId,
        voice: p.voice,
      })),
    );
    return payload.entries.length;
  }, [packs]);

  const matchablePacks: MatchablePack[] = useMemo(
    () =>
      packs
        .map((p) => ({
          packId: asString(p.packId),
          name: asString(p.name),
          sourceCharacterId: asString(p.sourceCharacterId),
        }))
        .filter((p) => p.packId.length > 0),
    [packs],
  );

  const handleAutoSuggest = async () => {
    setStatus(null);
    setStatusTone("info");
    try {
      const payload = await suggestVoiceCast(
        packs.map((p) => ({
          name: asString(p.name),
          sourceCharacterId: asString(p.sourceCharacterId),
          voice: asString(p.voice),
          dnaJson: asString(p.dnaJson),
        })),
      );
      if (payload.entries.length === 0) {
        setStatusTone("info");
        setStatus(
          "No suggestions — every pack already has a voice. Use Import with overwrite if you want to regenerate.",
        );
        return;
      }
      // Populate the Import textarea with the proposed JSON so the
      // existing import flow handles preview + Apply. Producers audit
      // before committing — no silent overwrites.
      setMode("import");
      setText(stringifyVoiceCast(payload));
      setStatusTone("success");
      setStatus(
        `Drafted ${payload.entries.length} suggestion${payload.entries.length === 1 ? "" : "s"} — review and Apply to commit.`,
      );
    } catch (err) {
      setStatusTone("error");
      setStatus(
        err instanceof Error ? err.message : "Auto-suggest failed unexpectedly.",
      );
    }
  };

  const handleExport = async () => {
    setStatus(null);
    setStatusTone("info");
    try {
      const payload = serializeVoiceCast(
        packs.map((p) => ({
          name: p.name,
          sourceCharacterId: p.sourceCharacterId,
          voice: p.voice,
        })),
      );
      const json = stringifyVoiceCast(payload);
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(json);
        setStatusTone("success");
        setStatus(
          `Copied ${payload.entries.length} voice assignment${payload.entries.length === 1 ? "" : "s"} to clipboard.`,
        );
      } else {
        // Fallback: surface the JSON in the textarea so the producer
        // can manually copy it. Covers old browsers + non-HTTPS dev.
        setMode("import");
        setText(json);
        setStatusTone("info");
        setStatus(
          "Clipboard unavailable — JSON rendered inline; copy manually.",
        );
      }
    } catch (err) {
      setStatusTone("error");
      setStatus(
        err instanceof Error ? err.message : "Export failed unexpectedly.",
      );
    }
  };

  const handleImport = async () => {
    setBusy(true);
    setStatus(null);
    setStatusTone("info");
    try {
      const parsed = parseVoiceCast(text);
      if (parsed.error || !parsed.payload) {
        setStatusTone("error");
        setStatus(`Import failed: ${parsed.error ?? "invalid payload"}`);
        return;
      }
      const plan = planVoiceCastImport(parsed.payload.entries, matchablePacks);
      if (plan.matches.length === 0) {
        setStatusTone("error");
        setStatus(
          `No matching packs for any of the ${parsed.payload.entries.length} entr${parsed.payload.entries.length === 1 ? "y" : "ies"}.`,
        );
        return;
      }
      let applied = 0;
      let failed = 0;
      for (const match of plan.matches) {
        try {
          await onSetIdentityPackVoice(match.packId, match.entry.voice);
          applied += 1;
        } catch {
          failed += 1;
        }
      }
      const pieces: string[] = [];
      pieces.push(`Applied ${applied}/${plan.matches.length} voice${plan.matches.length === 1 ? "" : "s"}`);
      if (failed > 0) pieces.push(`${failed} failed`);
      if (plan.unmatched.length > 0)
        pieces.push(`${plan.unmatched.length} unmatched`);
      if (parsed.droppedCount > 0)
        pieces.push(`${parsed.droppedCount} dropped (invalid entries)`);
      setStatusTone(failed > 0 ? "error" : "success");
      setStatus(pieces.join(" · "));
      if (failed === 0 && plan.unmatched.length === 0) {
        setMode("idle");
        setText("");
      }
    } finally {
      setBusy(false);
    }
  };

  const statusClass =
    statusTone === "error"
      ? "text-rose-400"
      : statusTone === "success"
        ? "text-emerald-400"
        : "text-zinc-400";

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="text-[10px] uppercase tracking-wide text-zinc-500"
          title="JSON round-trip for moving a cast between storyboards"
        >
          Voice cast
        </span>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={castCount === 0}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-200 disabled:opacity-40"
          title={
            castCount === 0
              ? "No packs have a voice assigned yet"
              : `Copy ${castCount} assignment${castCount === 1 ? "" : "s"} as JSON`
          }
        >
          Export ({castCount})
        </button>
        <button
          type="button"
          onClick={() => void handleAutoSuggest()}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-200"
          title="Propose voices for un-cast packs based on identity DNA"
        >
          Auto-suggest
        </button>
        <button
          type="button"
          onClick={() => {
            setMode((prev) => (prev === "import" ? "idle" : "import"));
            setStatus(null);
          }}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-200"
        >
          {mode === "import" ? "Cancel" : "Import…"}
        </button>
        {status ? (
          <span className={`text-[10px] ${statusClass}`}>{status}</span>
        ) : null}
      </div>
      {mode === "import" ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Paste voice-cast JSON here — either the full { kind: "voice-cast", entries: [...] } envelope or a bare [{ name, voice, sourceCharacterId? }, ...] array.'
            className="h-24 w-full resize-y rounded border border-zinc-700 bg-zinc-950 p-2 text-[10px] text-zinc-200"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={busy || text.trim().length === 0}
              className="rounded bg-emerald-700/70 px-2 py-0.5 text-[10px] text-zinc-100 disabled:opacity-40"
            >
              {busy ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// M6 — canonical OpenAI TTS voice roster surfaced in the picker. Kept
// in sync with `ALLOWED_VOICES` in /api/media/generate-audio/route.ts.
const VOICE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "(default)" },
  { value: "alloy", label: "alloy" },
  { value: "echo", label: "echo" },
  { value: "fable", label: "fable" },
  { value: "onyx", label: "onyx" },
  { value: "nova", label: "nova" },
  { value: "shimmer", label: "shimmer" },
];

function IdentityPackRow({
  pack,
  onPublishIdentityPack,
  onSetIdentityPackVoice,
  voiceClones,
  onSetPackVoiceClone,
  storyboardId,
  identityPortraitCallbacks,
}: {
  pack: Record<string, unknown>;
  onPublishIdentityPack?: (packId: string, publish: boolean) => Promise<void>;
  onSetIdentityPackVoice?: (packId: string, voice: string) => Promise<void>;
  /** M8 — producer's voice clones, fetched once by the parent. */
  voiceClones?: VoiceCloneRow[];
  /** M8 — attach / detach a clone to this pack. `voiceCloneId` of
   *  null clears the mapping. */
  onSetPackVoiceClone?: (
    packId: string,
    voiceCloneId: string | null,
  ) => Promise<void>;
  storyboardId?: string;
  identityPortraitCallbacks?: IdentityPortraitCallbacks;
}) {
  const packId = asString(pack.packId);
  const packRowId = asString(pack._id);
  const name = asString(pack.name, packId || "Identity Pack");
  const description = asString(pack.description);
  const visibility = asString(pack.visibility, "project");
  const published = asBool(pack.published);
  const sourceCharacterId = asString(pack.sourceCharacterId);
  const voice = asString(pack.voice);
  const voiceCloneId = asString(pack.voiceCloneId);
  const dnaJson = asString(pack.dnaJson);
  const [expanded, setExpanded] = useState(false);
  const [portraitsExpanded, setPortraitsExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Single audio element per row — we swap its src each preview so
  // clicking a second preview interrupts the first instead of layering
  // two voices on top of each other.
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const dnaPreview = useMemo(() => {
    if (!dnaJson) return "";
    try {
      return JSON.stringify(JSON.parse(dnaJson), null, 2);
    } catch {
      return dnaJson;
    }
  }, [dnaJson]);

  const togglePublished = async () => {
    if (!onPublishIdentityPack || !packId || busy) return;
    setBusy(true);
    try {
      await onPublishIdentityPack(packId, !published);
    } finally {
      setBusy(false);
    }
  };

  const handleVoiceChange = async (next: string) => {
    if (!onSetIdentityPackVoice || !packId) return;
    setVoiceBusy(true);
    try {
      await onSetIdentityPackVoice(packId, next);
    } finally {
      setVoiceBusy(false);
    }
  };

  const handleCloneChange = async (next: string) => {
    if (!onSetPackVoiceClone || !packId) return;
    setCloneBusy(true);
    try {
      await onSetPackVoiceClone(packId, next.length > 0 ? next : null);
    } finally {
      setCloneBusy(false);
    }
  };

  const playVoicePreview = async () => {
    // Nothing to audition when the pack is on the default voice — the
    // button is disabled in that state, but guard anyway for safety.
    if (!voice || previewBusy) return;
    setPreviewError(null);
    setPreviewBusy(true);
    try {
      const res = await fetch(
        `/api/media/preview-voice?voice=${encodeURIComponent(voice)}`,
        { method: "GET", cache: "no-store" },
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(
          `preview ${res.status}: ${msg.slice(0, 160) || "unknown error"}`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // Reuse the same <audio> across clicks so a second preview
      // interrupts the first. Revoke the previous object URL to let
      // the browser GC the bytes.
      const prev = previewAudioRef.current;
      if (prev) {
        prev.pause();
        const prevSrc = prev.src;
        if (prevSrc.startsWith("blob:")) {
          URL.revokeObjectURL(prevSrc);
        }
      }
      const audio = prev ?? new Audio();
      previewAudioRef.current = audio;
      audio.src = url;
      await audio.play();
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "voice preview failed",
      );
    } finally {
      setPreviewBusy(false);
    }
  };

  // Release the last object URL when the row unmounts. Skipping this
  // leaks a mp3-sized Blob per audition until the next full page reload.
  useEffect(() => {
    return () => {
      const audio = previewAudioRef.current;
      if (!audio) return;
      audio.pause();
      if (audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }
    };
  }, []);

  return (
    <div className="rounded border border-zinc-800 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium truncate">{name}</p>
          <p className="text-[11px] text-zinc-400">
            {visibility}
            {published ? " • published" : ""}
            {sourceCharacterId ? ` • source ${sourceCharacterId}` : ""}
          </p>
          {description ? (
            <p className="text-[11px] text-zinc-500 line-clamp-2">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onSetIdentityPackVoice && packId ? (
            <div className="flex items-center gap-1">
              <label
                className="flex items-center gap-1 text-[10px] text-zinc-400"
                title="OpenAI TTS voice the audio batch uses when this character is the detected speaker"
              >
                <span className="uppercase tracking-wide">Voice</span>
                <select
                  value={voice}
                  onChange={(e) => void handleVoiceChange(e.target.value)}
                  disabled={voiceBusy}
                  className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-200 disabled:opacity-50"
                >
                  {VOICE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void playVoicePreview()}
                disabled={!voice || previewBusy}
                title={
                  voice
                    ? `Play a short sample of the "${voice}" voice`
                    : "Select a voice to enable preview"
                }
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-200 disabled:opacity-40"
              >
                {previewBusy ? "…" : "▶"}
              </button>
              {/* M8 — voice clone picker. When a clone is attached,
                  the audio batch routes this character's lines
                  through ElevenLabs. Hidden when the producer has no
                  clones yet (zero-config install stays clean). */}
              {onSetPackVoiceClone && voiceClones && voiceClones.length > 0 ? (
                <label
                  className="flex items-center gap-1 text-[10px] text-zinc-400"
                  title={
                    voiceCloneId
                      ? "Clone override: this character will speak with the cloned voice (ElevenLabs)."
                      : "No clone attached — routes through OpenAI preset."
                  }
                >
                  <span className="uppercase tracking-wide">Clone</span>
                  <select
                    value={voiceCloneId}
                    onChange={(e) => void handleCloneChange(e.target.value)}
                    disabled={cloneBusy}
                    className="max-w-[120px] rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-200 disabled:opacity-50"
                  >
                    <option value="">(none)</option>
                    {voiceClones.map((clone) => (
                      <option key={clone._id} value={clone._id}>
                        {clone.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          {onPublishIdentityPack && packId ? (
            <button
              type="button"
              className="rounded bg-zinc-800 px-2 py-1 text-[10px] disabled:opacity-40"
              onClick={() => void togglePublished()}
              disabled={busy}
            >
              {published ? "Unpublish" : "Publish"}
            </button>
          ) : null}
        </div>
      </div>
      {previewError ? (
        <p className="mt-1 text-[10px] text-rose-400" title={previewError}>
          preview failed: {previewError}
        </p>
      ) : null}
      {dnaPreview ? (
        <button
          type="button"
          className="mt-1 text-[10px] text-zinc-400 underline underline-offset-2"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Hide DNA" : "Show DNA"}
        </button>
      ) : null}
      {expanded && dnaPreview ? (
        <pre className="mt-1 max-h-40 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 text-[10px] text-zinc-300">
          {dnaPreview}
        </pre>
      ) : null}

      {/* Reference portraits collapsible. Only mounts its useQuery subtree
          when the row is expanded, so the drawer's Identity tab stays
          lightweight on first open. */}
      {packRowId ? (
        <div className="mt-2 border-t border-zinc-800 pt-2">
          <button
            type="button"
            className="text-[10px] text-zinc-400 underline underline-offset-2"
            onClick={() => setPortraitsExpanded((prev) => !prev)}
          >
            {portraitsExpanded ? "Hide reference portraits" : "Reference portraits"}
          </button>
          {portraitsExpanded ? (
            <ReferencePortraitsSection
              storyboardId={storyboardId}
              packRowId={packRowId}
              callbacks={identityPortraitCallbacks}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReferencePortraitsSection({
  storyboardId,
  packRowId,
  callbacks,
}: {
  storyboardId?: string;
  packRowId: string;
  callbacks?: IdentityPortraitCallbacks;
}) {
  // Skip the query entirely until we know which storyboard this row belongs
  // to. Convex `useQuery` treats `"skip"` as "don't subscribe", so the
  // section renders a gentle empty state instead of querying against an
  // empty id.
  const portraits = useQuery(
    queryRef("identityReferences:listIdentityPortraitsForPack"),
    storyboardId
      ? { storyboardId, ownerPackId: packRowId }
      : "skip",
  ) as IdentityReferenceRecord[] | undefined;

  const [addOpen, setAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [viewDraft, setViewDraft] = useState<PortraitView>("front");
  const [urlDraft, setUrlDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const ordered = useMemo(
    () => (portraits ? orderPortraitsCanonically(portraits) : []),
    [portraits],
  );
  const status = useMemo(
    () => portraitSetStatus(portraits ?? []),
    [portraits],
  );

  if (!storyboardId) {
    return (
      <p className="mt-2 text-[11px] text-zinc-500">
        Open a storyboard to manage portraits.
      </p>
    );
  }

  const canAdd = Boolean(callbacks?.addPortrait);
  const canRemove = Boolean(callbacks?.removePortrait);

  const submit = async () => {
    if (!callbacks?.addPortrait) return;
    const url = urlDraft.trim();
    if (!url) return;
    setSubmitting(true);
    try {
      await callbacks.addPortrait({
        storyboardId,
        ownerPackId: packRowId,
        portraitView: viewDraft,
        sourceUrl: url,
        notes: notesDraft.trim() || undefined,
      });
      setUrlDraft("");
      setNotesDraft("");
      setViewDraft("front");
      setAddOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (referenceId: string) => {
    if (!callbacks?.removePortrait) return;
    setBusyId(referenceId);
    try {
      await callbacks.removePortrait({ referenceId });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      {/* Canonical three-view status. Emerald tick = present, slate dot = missing. */}
      <div className="flex items-center gap-2 text-[10px] text-zinc-400">
        <span className="uppercase tracking-wide text-zinc-500">3-view</span>
        <CanonicalBadge label="Front" ok={status.hasFront} />
        <CanonicalBadge label="Side" ok={status.hasSide} />
        <CanonicalBadge label="Back" ok={status.hasBack} />
        {status.hasCanonicalThreeView ? (
          <span className="text-emerald-400">complete</span>
        ) : (
          <span className="text-zinc-500">
            missing {status.missingCanonical.join(", ")}
          </span>
        )}
      </div>

      {portraits === undefined ? (
        <p className="text-[11px] text-zinc-500">Loading portraits...</p>
      ) : ordered.length === 0 ? (
        <p className="text-[11px] text-zinc-500">No reference portraits yet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {ordered.map((portrait) => (
            <PortraitThumb
              key={portrait._id}
              portrait={portrait}
              busy={busyId === portrait._id}
              canRemove={canRemove}
              onRemove={() => void remove(portrait._id)}
            />
          ))}
        </div>
      )}

      {canAdd ? (
        <div className="mt-1">
          {addOpen ? (
            <div className="rounded border border-zinc-800 p-2 space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wide text-zinc-500 w-10">
                  View
                </label>
                <select
                  value={viewDraft}
                  onChange={(e) => setViewDraft(e.target.value as PortraitView)}
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                >
                  {PORTRAIT_VIEW_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wide text-zinc-500 w-10">
                  URL
                </label>
                <input
                  type="url"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  placeholder="https://..."
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                />
              </div>
              <div className="flex items-start gap-2">
                <label className="text-[10px] uppercase tracking-wide text-zinc-500 w-10 pt-1">
                  Notes
                </label>
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={2}
                  placeholder="Optional"
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300"
                  onClick={() => {
                    setAddOpen(false);
                    setUrlDraft("");
                    setNotesDraft("");
                  }}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-emerald-700 px-2 py-1 text-[10px] text-white disabled:opacity-40"
                  onClick={() => void submit()}
                  disabled={submitting || !urlDraft.trim()}
                >
                  {submitting ? "Adding..." : "Add"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300"
              onClick={() => setAddOpen(true)}
            >
              + Add portrait
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CanonicalBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] " +
        (ok
          ? "bg-emerald-900/40 text-emerald-300"
          : "bg-zinc-800 text-zinc-500")
      }
    >
      <span aria-hidden>{ok ? "✓" : "·"}</span>
      {label}
    </span>
  );
}

function PortraitThumb({
  portrait,
  busy,
  canRemove,
  onRemove,
}: {
  portrait: IdentityReferenceRecord;
  busy: boolean;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const viewLabel =
    PORTRAIT_VIEW_OPTIONS.find((opt) => opt.value === portrait.portraitView)?.label ??
    (portrait.portraitView ?? "unknown");
  return (
    <div className="relative group">
      <img
        src={portrait.sourceUrl}
        alt={viewLabel}
        className="aspect-square w-full object-cover rounded border border-border/60"
      />
      <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-zinc-400">
        <span className="truncate">{viewLabel}</span>
        {canRemove ? (
          <button
            type="button"
            className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-300 disabled:opacity-40"
            onClick={onRemove}
            disabled={busy}
            aria-label="Remove portrait"
            title="Remove portrait"
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ConstraintsView({
  constraints,
}: {
  constraints: Array<Record<string, unknown>>;
}) {
  if (constraints.length === 0) {
    return <p className="text-[11px] text-zinc-500">No enabled constraints.</p>;
  }
  return (
    <>
      {constraints.slice(0, 12).map((row, index) => (
        <ConstraintRow
          key={asString(row.constraintId, `constraint_${index}`)}
          row={row}
        />
      ))}
    </>
  );
}

function severityClass(severity: string): string {
  switch (severity) {
    case "critical":
      return "text-rose-300";
    case "high":
      return "text-orange-300";
    case "medium":
      return "text-amber-300";
    case "low":
    default:
      return "text-emerald-300";
  }
}

function ConstraintRow({ row }: { row: Record<string, unknown> }) {
  const name = asString(row.name, asString(row.constraintId, "Constraint"));
  const description = asString(row.description);
  const severity = asString(row.severity, "medium");
  const scope = asString(row.scope, "character");
  const expressionJson = asString(row.expressionJson);
  const [expanded, setExpanded] = useState(false);

  const pretty = useMemo(() => {
    if (!expressionJson) return "";
    try {
      return JSON.stringify(JSON.parse(expressionJson), null, 2);
    } catch {
      return expressionJson;
    }
  }, [expressionJson]);

  return (
    <div className="rounded border border-zinc-800 p-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">{name}</p>
        <span className={"text-[10px] uppercase tracking-wide " + severityClass(severity)}>
          {severity}
        </span>
      </div>
      <p className="text-[11px] text-zinc-400">
        scope: {scope}
      </p>
      {description ? (
        <p className="mt-0.5 text-[11px] text-zinc-500 line-clamp-2">{description}</p>
      ) : null}
      {pretty ? (
        <button
          type="button"
          className="mt-1 text-[10px] text-zinc-400 underline underline-offset-2"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Hide expression" : "Show expression"}
        </button>
      ) : null}
      {expanded && pretty ? (
        <pre className="mt-1 max-h-40 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 text-[10px] text-zinc-300">
          {pretty}
        </pre>
      ) : null}
    </div>
  );
}

function ViolationsView({
  violations,
  onResolveViolation,
}: {
  violations: Array<Record<string, unknown>>;
  onResolveViolation?: (violationId: string, status: ViolationStatus) => Promise<void>;
}) {
  if (violations.length === 0) {
    return <p className="text-[11px] text-zinc-500">No open contradictions.</p>;
  }
  return (
    <>
      {violations.slice(0, 10).map((row, index) => (
        <ViolationRow
          key={asString(row.violationId, `vio_${index}`)}
          row={row}
          onResolveViolation={onResolveViolation}
        />
      ))}
    </>
  );
}

function ViolationRow({
  row,
  onResolveViolation,
}: {
  row: Record<string, unknown>;
  onResolveViolation?: (violationId: string, status: ViolationStatus) => Promise<void>;
}) {
  const violationId = asString(row.violationId);
  const code = asString(row.code, "VIOLATION");
  const severity = asString(row.severity, "medium");
  const status = asString(row.status, "open");
  const message = asString(row.message);
  const suggestedFix = asString(row.suggestedFix);
  const nodeIds = asStringArray(row.nodeIds);
  const [busy, setBusy] = useState(false);

  const decide = async (next: ViolationStatus) => {
    if (!onResolveViolation || !violationId || busy) return;
    setBusy(true);
    try {
      await onResolveViolation(violationId, next);
    } finally {
      setBusy(false);
    }
  };

  const terminal = status === "resolved";

  return (
    <div className="rounded border border-zinc-800 p-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">{code}</p>
        <span className={"text-[10px] uppercase tracking-wide " + severityClass(severity)}>
          {severity}
        </span>
      </div>
      <p className="text-[11px] text-zinc-400">{status}</p>
      {message ? <p className="mt-1 text-[11px] text-zinc-300">{message}</p> : null}
      {suggestedFix ? (
        <p className="mt-1 text-[11px] text-emerald-300/80">Fix: {suggestedFix}</p>
      ) : null}
      {nodeIds.length > 0 ? (
        <p className="mt-1 text-[10px] text-zinc-500">
          nodes: {nodeIds.slice(0, 6).join(", ")}
          {nodeIds.length > 6 ? ` (+${nodeIds.length - 6})` : ""}
        </p>
      ) : null}
      {onResolveViolation && violationId ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="rounded bg-amber-700 px-2 py-1 text-[10px] disabled:opacity-40"
            onClick={() => void decide("acknowledged")}
            disabled={busy || terminal || status === "acknowledged"}
          >
            Acknowledge
          </button>
          <button
            type="button"
            className="rounded bg-emerald-700 px-2 py-1 text-[10px] disabled:opacity-40"
            onClick={() => void decide("resolved")}
            disabled={busy || terminal}
          >
            Resolve
          </button>
        </div>
      ) : null}
    </div>
  );
}

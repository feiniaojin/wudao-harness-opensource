// InputBox — the multi-line input, the web mirror of the TUI's TextInput
// (cli/src/tui/input.tsx): Enter submits / Shift+Enter newlines / `\`+Enter
// continues, ↑/↓ walk the submitted-prompt history at the buffer's first/
// last line, a line still inside its slash-command word opens the
// suggestion menu (Tab/Enter complete, ↑/↓ select, Esc dismisses for that
// token), an @-token shows the mention hint, and shift+tab cycles the
// permission mode. The native textarea owns char editing and paste; the
// DECISION rules come from src/input-state.ts (the reused TUI machine).
//
// M79b §1: the composer card also owns the image rail — the 📎 chip opens an
// image/* picker, an OS drag-drop onto the card adds too, picked files mint
// blob-URL thumbnails (browser-only drafts, src/attachments.ts), and submit
// exchanges them through the host: onSubmit(text, imageInputs) returns
// success/failure and ONLY success releases the drafts (dsh pattern — a
// failed send keeps the rail and the text for retry).
import { useEffect, useId, useRef, useState } from "react";
import type { Mode } from "../protocol.js";
import { cycleMode } from "../protocol.js";
import type { RecentModel } from "../recent-models-store.js";
import type { SlashCommandInfo } from "../slash.js";
import { completeSlashLine, filterSlashCommands, slashToken, suggestWindow } from "../slash.js";
import {
  caretLine,
  caretPos,
  createInputHistory,
  enterAction,
  recallNewer,
  recallOlder,
  recalledText,
  submitToHistory,
} from "../input-state.js";
import type { InputHistory } from "../input-state.js";
import {
  admitFiles,
  admitFileBatch,
  createDraft,
  createFileDraft,
  readFileAsBase64,
  releaseDraft,
} from "../attachments.js";
import type { ComposerImageDraft, ComposerImageInput, ComposerFileDraft, ComposerFileInput, SubmitWithImages } from "../attachments.js";
import { IconArrowUp, IconClose, IconFile, IconPaperclip, IconSlash } from "./icons.js";
import { Icon } from "./Icon.js";
import { dropIntentChips } from "../drop-intent.js";
import { ShieldSelector, shieldValueOf } from "./ShieldSelector.js";
import type { ShieldMode } from "./ShieldSelector.js";
import { ModelSelector } from "./ModelSelector.js";
import { EffortSelector } from "./EffortSelector.js";
// ω99-151: IME 组合期键盘守卫的 A 层（纯函数）——两个 onKeyDown 的顶置接线。
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";

export interface InputBoxProps {
  readonly busy: boolean;
  readonly mode: Mode;
  readonly commands: readonly SlashCommandInfo[];
  /** False while reconnecting/gave-up: submit is disabled (steering a dead
   *  socket is meaningless), the draft stays editable, and mode clicks queue
   *  client-side and flush on reconnect. */
  readonly connected: boolean;
  /** M79b: text-only submits keep the historical void handshake (the buffer
   *  clears synchronously). With image inputs the return becomes the draft
   *  lease: resolve false (or reject) and the rail + text stay for retry;
   *  anything else releases them. The host owns attachmentSave + submit. */
  readonly onSubmit: SubmitWithImages;
  readonly onInterrupt: () => void;
  /** 0.3.13: the ShieldSelector (the ONE mode switcher — the modechip cycle
   *  button retired after the user's two-switcher report) needs the direct
   *  pick, not just the shift+tab cycle. */
  readonly onShield: (mode: ShieldMode) => void;
  readonly onCycleMode: () => void;
  /** M53 §1: an external buffer replacement (/edit puts a prior message back
   *  in the input). `nonce` keys the effect — arming the same message twice
   *  still replaces; the caret lands at the end. */
  readonly draft?: { readonly text: string; readonly nonce: number };
  /** Fires when the draft above was APPLIED to the buffer — the armer
   *  (App) clears its state so a later composer remount doesn't restore the
   *  stale text into a fresh buffer (M63 §D review NIT). */
  readonly onDraftApplied?: () => void;
  /** M74-ide §4: an external @-mention arm (the file tree's @ button). The
   *  workspace-relative path is APPENDED to the buffer as a trailing `@path`
   *  token — exactly the shape the existing mention machinery already
   *  understands (the @chip hint here) and the driver's M35 expand pipeline
   *  resolves against the workspace root on submit. `nonce` keys the effect
   *  so arming the same file twice still applies. */
  readonly mention?: { readonly path: string; readonly nonce: number };
  /** Fires when the armed mention was APPENDED to the buffer — the armer
   *  clears its state (the onDraftApplied discipline). */
  readonly onMentionApplied?: () => void;
  /** M63 §D (simple composer): the novice worded placeholders and the node
   *  rendered beside the send button (the context ring). All optional —
   *  absent keeps the advanced surface byte-identical. M64-visual §2 adds
   *  the toolbar row's LEFT slot (controlsPrefix) beside the existing right
   *  slot: the simple composer rides its permission/lane chips in prefix. */
  readonly idlePlaceholder?: string;
  readonly busyPlaceholder?: string;
  readonly controlsPrefix?: React.ReactNode;
  readonly controlsSuffix?: React.ReactNode;
  /** 极简模式工作空间切换（spec §3.1）：工具行的 LEAD 槽，渲染在 📎 之前
   *  （.composer-tools 首位）——SimpleComposer 塞 WorkspaceChip 进来；absent
   *  keeps the surface byte-identical（高级模式不传）。 */
  readonly controlsLead?: React.ReactNode;
  /** Final-review F2: the advanced composer's `/` command chip (mockup §2 —
   *  高级模式多一个 `/` 命令芯片). Clicking focuses the textarea and puts
   *  "/" at the head of the draft; absent keeps the toolbar as-was (the
   *  simple composer never passes it). */
  readonly slashChip?: boolean;
  /** ω99-316 (/btw 侧问): the「顺便问」chip's submit lane. Present → the
   *  chip renders; armed → the next TEXT submit routes here instead of
   *  onSubmit (busy/idle alike — the side lane never touches the queue or
   *  the steering lane), then disarms. Absent keeps the composer
   *  byte-identical. Attachments stay on the rail through an armed send
   *  (the side lane is text-only by contract). */
  readonly onSideAsk?: (text: string) => void;
  /** ui-review-r2 I1/I4: every buffer change reports OUT (an App-held ref,
   *  not state — no per-keystroke re-render rides through the shell). The
   *  App reads the ref to (a) park the draft across an ask/modal unmount and
   *  (b) guard destructive exits (workspace switch) on an unsent draft. */
  readonly onBufferChange?: (text: string) => void;
  /** M79b (I1 parity for images): every rail change reports OUT to an App
   *  ref. When present, an UNMOUNT parks the drafts there instead of
   *  revoking them — the re-mounted composer re-adopts them via imageSeed.
   *  Without the seam (standalone render), unmount still revokes. */
  readonly onImagesChange?: (drafts: readonly ComposerImageDraft[]) => void;
  /** ω99-55: the file rail's park seam (the onImagesChange discipline — an
   *  ask/modal that took the input area must not eat staged files). */
  readonly onFilesChange?: (drafts: readonly ComposerFileDraft[]) => void;
  /** ω99-55: the file rail's re-adoption seed (the imageSeed discipline). */
  readonly fileSeed?: { readonly drafts: readonly ComposerFileDraft[]; readonly nonce: number };
  /** ω99-55: called when a parked file rail was re-adopted. */
  readonly onFileSeedApplied?: () => void;
  /** M79b: the parked rail, re-armed after an ask/modal unmount — `nonce`
   *  keys the effect so parking the same drafts twice still applies. */
  readonly imageSeed?: { readonly drafts: readonly ComposerImageDraft[]; readonly nonce: number };
  /** Fires when the seed above was ADOPTED — the armer drops it (the
   *  onDraftApplied discipline). */
  readonly onImageSeedApplied?: () => void;
  /** 输入框下方模型/强度 chips（spec 2026-08-28 §2.2/2.4 + 用户反馈
   *  2026-08-28 不要弹窗）：模型 chip 直接弹 ModelSelector 下拉（强度/模式
   *  同款 .pop/.menu）；label/choices null → 不渲染（与状态栏模型段同款
   *  可选性）。onPickModel 携带 (model, provider)——同端点行走 /model、跨端
   *  点行走 /provider，由 App 端 modelPickCommand 路由。 */
  readonly modelLabel?: string | null;
  readonly modelProvider?: string;
  readonly modelChoices?: readonly { readonly provider: string; readonly model: string; readonly source: string }[] | null;
  /** ω99-218: #3 — 最近使用 (provider, model) 对，纯透传给 ModelSelector 的
   *  recent（左列「最近使用」虚拟组）；零喂 = 旧行为（无虚拟组行）。 */
  readonly modelRecent?: readonly RecentModel[] | null;
  readonly onPickModel?: (model: string, provider: string) => void;
  /** The ModelSelector footer — persists the session's CURRENT model as the
   *  boot default (the R6 Ctrl+S lane, made visible). */
  readonly onPersistModelDefault?: () => void;
  /** 推理强度 chip（EffortSelector）：efforts 为空（供应商不支持推理档）整个
   *  不渲染；两 chip 均 busy 可切（下一轮生效），仅 !connected 禁用。 */
  readonly effort?: string | null;
  readonly efforts?: readonly string[];
  readonly onPickEffort?: (level: string) => void;
  /** S5: the EffortSelector 设为 {provider} 默认 footer (the provider
   *  registry binding pin; absent = no footer). */
  readonly effortProviderLabel?: string;
  readonly onPersistEffortDefault?: () => void;
}

interface SuggestState {
  readonly token: string;
  readonly selected: number;
  readonly dismissed: string | null;
}

const SUGGEST_CLOSED: SuggestState = { token: "", selected: 0, dismissed: null };

// M75-ux2 §12: auto-grow — the textarea's rows track the buffer's VISUAL
// line count, 1 (empty) up to the 6-row cap (past it the textarea scrolls
// internally; overflow-y is the browser's default for a sized textarea).
// Hard newlines are exact; soft wraps are an estimate — chars-per-line from
// the LIVE textarea (a mono glyph ≈ 0.62em), with an 80-col fallback for
// the unmeasured case (first paint, jsdom) that the deterministic tests
// ride. The estimate never fights the newline count: each logical line
// contributes its own wrapped-line count.
const GROW_CAP = 6;
const FALLBACK_COLS = 80;

/** ω99-55: one file card's human byte size (B → KB → MB, 1 fraction digit). */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function colsOf(ta: HTMLTextAreaElement | null): number {
  if (ta !== null && ta.clientWidth > 0) {
    const px = Number.parseFloat(window.getComputedStyle(ta).fontSize);
    return Math.max(16, Math.floor(ta.clientWidth / ((Number.isFinite(px) ? px : 13) * 0.62)));
  }
  return FALLBACK_COLS;
}

/** The estimated VISUAL row count of the buffer, capped for `rows`. */
function growRows(text: string, cols: number): number {
  let n = 0;
  for (const ln of text.split("\n")) n += Math.max(1, Math.ceil(ln.length / cols));
  return Math.min(GROW_CAP, Math.max(1, n));
}

/** An @-mention token at a word boundary (the driver expands on submit —
 *  this only surfaces the hint). */
function mentionToken(line: string): string | undefined {
  const m = /(?:^|\s)@([^\s@]+)$/.exec(line);
  return m?.[1];
}

export function InputBox(props: InputBoxProps): React.JSX.Element {
  const { busy, mode, commands, connected, onSubmit, onInterrupt, onShield, onCycleMode, draft, onDraftApplied, mention, onMentionApplied, idlePlaceholder, busyPlaceholder, controlsLead, controlsPrefix, controlsSuffix, slashChip, onSideAsk, onBufferChange, onImagesChange, imageSeed, onImageSeedApplied, onFilesChange, fileSeed, onFileSeedApplied, modelLabel, modelProvider, modelChoices, modelRecent, onPickModel, onPersistModelDefault, effort, efforts, onPickEffort, effortProviderLabel, onPersistEffortDefault } = props;
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<InputHistory>(createInputHistory);
  const [suggest, setSuggest] = useState<SuggestState>(SUGGEST_CLOSED);
  // ω99-316 (/btw 侧问): the「顺便问」chip's armed flag — the NEXT text
  // submit routes to onSideAsk, then it self-resets (one shot per arm).
  const [sideArmed, setSideArmed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // ω99-151: IME 组合态——textarea 自持（ω99-203: 吩咐加颗小框一份随行退役）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  // UI-4 C9: the slash menu's id namespace — rows get stable ids so the
  // listbox can point aria-activedescendant at the highlighted row (SRs
  // then announce the ↑/↓ highlight moves; the textarea keeps DOM focus).
  // useId scopes to the composer instance, so two mounted composers can
  // never mint colliding row ids.
  const menuId = useId();

  // --- M79b §1: the image rail (browser-only drafts) -----------------------
  //
  // images is UI state; imagesRef mirrors it so the add/remove/unmount paths
  // read the truth without racing a scheduled setState. All blob-URL minting
  // happens OUTSIDE state updaters (StrictMode double-invokes them; a
  // createObjectURL inside would leak).
  const [images, setImages] = useState<readonly ComposerImageDraft[]>([]);
  const imagesRef = useRef<readonly ComposerImageDraft[]>([]);
  const putImages = (next: readonly ComposerImageDraft[]): void => {
    imagesRef.current = next;
    setImages(next);
    onImagesChange?.(next);
  };
  /** One transient pre-flight/notice line under the composer (over-limit,
   *  non-image drops); cleared by the next clean action. */
  const [imgNotice, setImgNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ω99-55 — the FILE lane's state (name+size cards; no blob URLs).
  const [fileDrafts, setFileDrafts] = useState<readonly ComposerFileDraft[]>([]);
  const fileDraftsRef = useRef<readonly ComposerFileDraft[]>([]);
  const putFileDrafts = (next: readonly ComposerFileDraft[]): void => {
    fileDraftsRef.current = next;
    setFileDrafts(next);
    onFilesChange?.(next);
  };
  const fileLaneInputRef = useRef<HTMLInputElement>(null);
  /** True while the submit-with-images handshake is in flight (Enter and the
   *  send button both stand down — a double send would double-upload). */
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // M79b (I1 parity): a parked rail re-adopts on the next mount — an ask /
  // modal that took the input area must not eat staged images (the text
  // draft already survives the same way).
  useEffect(() => {
    if (imageSeed === undefined) return;
    putImages(imageSeed.drafts);
    onImageSeedApplied?.();
    // nonce keys the effect; the array identity is the parked truth.
  }, [imageSeed?.nonce]);

  // ω99-55: the file rail re-adopts the same way (a parked rail survives an
  // ask/modal takeover — no blob URLs to manage, just the drafts).
  useEffect(() => {
    if (fileSeed === undefined) return;
    putFileDrafts(fileSeed.drafts);
    onFileSeedApplied?.();
  }, [fileSeed?.nonce]);

  /** ω99-55: add files to the FILE lane (the picker and the drop both land
   *  here; images never route in — they keep their own rail). */
  const addGenericFiles = (list: readonly File[] | FileList | null): void => {
    if (sendingRef.current) return;
    const files = list === null ? [] : [...list];
    if (files.length === 0) return;
    const { accepted, notice } = admitFileBatch(files, fileDraftsRef.current);
    if (accepted.length > 0) {
      putFileDrafts([...fileDraftsRef.current, ...accepted.map((f) => createFileDraft(f))]);
    }
    setImgNotice(notice);
  };

  const removeFileDraftAt = (index: number): void => {
    const cur = fileDraftsRef.current;
    if (cur[index] === undefined) return;
    putFileDrafts(cur.filter((_, i) => i !== index));
    setImgNotice(null);
  };

  const addFiles = (list: readonly File[] | FileList | null): void => {
    // m79b-review LOW: a pick/drop landing mid-handshake would join imagesRef
    // AFTER the lease snapshotted its drafts — the success path then runs
    // putImages([]) and silently discards the newcomer (blob URL leaked).
    // Adding stands down while a submit lease is in flight, like the × and
    // the send button already do.
    if (sendingRef.current) return;
    const files = list === null ? [] : [...list];
    if (files.length === 0) return;
    // Pre-flight the whole batch against the store's numbers (max 9,
    // cumulative base64 ≤ 20MiB): refuse BEFORE minting anything — nothing
    // rejected is added, nothing is sent. r5-P3: the notice names EVERY
    // rejection kind with its count (「2 张超过 20MiB · 1 张超出数量上限」),
    // not just whichever kind produced the first refusal.
    const { accepted, notice } = admitFiles(files, imagesRef.current);
    if (accepted.length > 0) {
      putImages([...imagesRef.current, ...accepted.map((f) => createDraft(f))]);
    }
    setImgNotice(notice);
  };

  const removeImageAt = (index: number): void => {
    const cur = imagesRef.current;
    const dropped = cur[index];
    if (dropped === undefined) return;
    releaseDraft(dropped);
    putImages(cur.filter((_, i) => i !== index));
    setImgNotice(null);
  };

  // Release every draft's blob URL when the composer unmounts — UNLESS the
  // park seam is wired (onImagesChange): then the App ref already holds the
  // live rail and the next mount re-adopts it (the I1 discipline). Standalone
  // mounts (no seam) keep the unconditional revoke.
  useEffect(() => {
    return () => {
      if (onImagesChange !== undefined) return;
      for (const d of imagesRef.current) releaseDraft(d);
    };
  }, []);

  // ui-review-r2 I1/I4: the single write path for the buffer — every change
  // (typing, recall, /edit arming, @-mention, submit's reset) reports out so
  // the App-held ref never goes stale.
  const applyValue = (text: string): void => {
    setValue(text);
    onBufferChange?.(text);
  };

  // M53 §1: an armed /edit replaces the whole buffer (caret at the end, menu
  // reset). Keyed by nonce so the App can re-arm the same text; the applied
  // draft reports back so the armer can drop it (no stale re-apply on a
  // later remount).
  useEffect(() => {
    if (draft === undefined) return;
    applyValue(draft.text);
    setSuggest(SUGGEST_CLOSED);
    ref.current?.focus();
    onDraftApplied?.();
  }, [draft?.nonce, draft?.text]);

  // M74-ide §4: an armed mention APPENDS a trailing `@path` token at the
  // buffer's tail — no trailing space (mentionToken only matches a token at
  // the very end, so the chip would hide) and a separating space only when
  // the buffer ends mid-word (a joined "text@path" would not match either).
  // The token then flows through the existing machinery unchanged: the hint
  // chip here, the driver's M35 expand on submit.
  useEffect(() => {
    if (mention === undefined) return;
    const sep = value === "" || /\s$/.test(value) ? "" : " ";
    applyValue(`${value}${sep}@${mention.path}`);
    setSuggest(SUGGEST_CLOSED);
    ref.current?.focus();
    onMentionApplied?.();
  }, [mention?.nonce, mention?.path]);

  // Keep the caret at the end after a history recall installs a buffer.
  const applyBuffer = (text: string, caret?: number): void => {
    applyValue(text);
    const at = caret ?? text.length;
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(at, at);
    });
  };

  const line = caretLine(value, ref.current?.selectionStart ?? value.length);
  const token = slashToken(line);
  const matches = token === undefined ? [] : filterSlashCommands(commands, token);
  const selected = suggest.token === token ? Math.min(suggest.selected, Math.max(0, matches.length - 1)) : 0;
  const menuOpen = token !== undefined && matches.length > 0 && suggest.dismissed !== token;
  const mentionHint = mentionToken(line);

  const complete = (name: string): void => {
    // Completion rebuilds the whole line — the caret sits at its end.
    const { row } = caretPos(value, ref.current?.selectionStart ?? value.length);
    const lines = value.split("\n");
    lines[row] = completeSlashLine(lines[row] ?? "", name);
    const next = lines.join("\n");
    applyBuffer(next);
    setSuggest({ token: name, selected: 0, dismissed: null });
  };

  // ω99-119: submit takes an optional override text — the intent chips fill
  // the buffer AND send in one gesture, and the closure's `value` is stale
  // within the same tick (state updates flush on the next render). The
  // override rides the EXISTING lease unchanged; Enter's bare call is
  // byte-identical to before.
  const submit = (overrideText?: string): void => {
    if (!connected || sendingRef.current) return; // offline / mid-handshake: Enter stands down too
    const text = overrideText ?? value;
    if (text.trim() === "" && imagesRef.current.length === 0 && fileDraftsRef.current.length === 0) return;
    // ω99-316: the armed「顺便问」lane — the next text submit routes to the
    // side question (busy/idle alike; never the queue, never the steering
    // lane — the side lane's whole point is not interrupting), then disarms.
    // The handshake mirrors the text-only main path (synchronous clear +
    // history row). Drafts on the rail stay put (text-only lane).
    if (sideArmed && onSideAsk !== undefined && text.trim() !== "") {
      applyValue("");
      setSuggest(SUGGEST_CLOSED);
      onSideAsk(text.trim());
      setHistory(submitToHistory(history, text));
      setSideArmed(false);
      return;
    }
    if (sideArmed) setSideArmed(false); // an armed empty/attachments-only send falls back to the main lane
    if (imagesRef.current.length === 0 && fileDraftsRef.current.length === 0) {
      // The text-only path keeps the historical synchronous handshake.
      applyValue("");
      setSuggest(SUGGEST_CLOSED);
      if (text.trim() !== "") {
        onSubmit(text);
        setHistory(submitToHistory(history, text));
      }
      return;
    }
    // M79b: with drafts mounted the send becomes a lease — read the bytes,
    // hand the host (text + inputs), and release ONLY on success. Failure
    // keeps the rail and the text exactly as they were (the host surfaced
    // the notice; the user edits and retries). ω99-55: file drafts ride the
    // SAME lease (either lane alone may be present).
    const drafts = imagesRef.current;
    const files = fileDraftsRef.current;
    sendingRef.current = true;
    setSending(true);
    void (async () => {
      let ok = false;
      try {
        const inputs: ComposerImageInput[] = [];
        for (const d of drafts) inputs.push({ data: await readFileAsBase64(d.file), mediaType: d.mediaType });
        const fileInputs: ComposerFileInput[] = [];
        for (const d of files) fileInputs.push({ data: await readFileAsBase64(d.file), name: d.name });
        // Arity discipline: a file-free send keeps the historical TWO-arg
        // call (pinned by the image-lease tests); files add the third arg.
        const fileArgs = fileInputs.length > 0 ? ([fileInputs] as const) : [];
        ok = (await onSubmit(text, inputs.length > 0 ? inputs : undefined, ...fileArgs)) !== false;
      } catch {
        ok = false;
      }
      sendingRef.current = false;
      setSending(false);
      if (!ok) return;
      for (const d of drafts) releaseDraft(d);
      putImages([]);
      putFileDrafts([]);
      setImgNotice(null);
      applyValue("");
      setSuggest(SUGGEST_CLOSED);
      if (text.trim() !== "") setHistory(submitToHistory(history, text));
    })();
  };

  // Final-review F2: the `/` chip — focus the textarea and put "/" at the
  // head of the draft (idempotent: a draft already starting with "/" only
  // refocuses). An empty buffer turns into "/" so the slash menu opens on
  // the fresh token; the dismissal resets so the menu reliably appears.
  const onSlashChip = (): void => {
    ref.current?.focus();
    if (value.startsWith("/")) return;
    applyBuffer(`/${value}`, 1);
    setSuggest(SUGGEST_CLOSED);
  };

  // ω99-119 — the suggestion chips row (拖文件即起草). The A layer maps the
  // rail's file names to three intent chips (the copy table lives in
  // drop-intent.ts, pinned verbatim by its tests); the row renders only
  // while the rail holds drafts AND the buffer is empty (双条件) — typing
  // hides it, clearing brings it back, the drafts themselves are never
  // retracted by it (the file cards own their removal).
  const intentChips =
    fileDrafts.length > 0 && value.trim() === "" ? dropIntentChips(fileDrafts.map((d) => d.name)) : [];

  /** 一键意图：填文本 + 既有 submit 同一手势直发（override 穿 lease——
   *  closure 里的 value 在本 tick 还是旧的）。失败文本留在框里可改可重试。 */
  const sendIntent = (text: string): void => {
    applyValue(text);
    submit(text);
  };

  // ω99-203: #1 — 一键短语行整族退役（用户令：行占输入框高度、无人用、
  //  输入框应干净；整族退役非隐藏）：import、A 层依赖、state+handlers、
  //  行 JSX 全删；残留 storage lane 无人读即无害，不写清理代码。

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    /* ω99-151: 组合期 IME 拥有键盘——Enter/↑↓/Esc 全部让位（盖整个
     *  handler，不只 Enter；只吞激活不吞输入，不 preventDefault）。 */
    if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
    // --- the suggestion menu owns these keys while open ---
    if (menuOpen) {
      // M75-ux2 §3: Ctrl/Cmd-Tab belongs to the App's tab strip — the menu
      // completes only on a BARE Tab.
      if ((e.key === "Tab" && !e.ctrlKey && !e.metaKey) || (e.key === "Enter" && token !== matches[selected]?.name)) {
        e.preventDefault();
        const picked = matches[selected] ?? matches[0];
        if (picked !== undefined) complete(picked.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggest({ token: token ?? "", selected: 0, dismissed: token });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggest({ token: token ?? "", selected: Math.max(0, selected - 1), dismissed: null });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggest({ token: token ?? "", selected: Math.min(matches.length - 1, selected + 1), dismissed: null });
        return;
      }
    }

    // M75-ux2 §3: a BARE shift+tab cycles the permission mode; the
    // ctrl/cmd-modified Tab pair is the App's tab-strip gesture.
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      onCycleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const action = enterAction(value, ref.current?.selectionStart ?? value.length);
      if (action.kind === "submit") submit();
      else applyBuffer(action.value, action.caret);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const pos = caretPos(value, ref.current?.selectionStart ?? value.length);
      const lines = value.split("\n");
      if (e.key === "ArrowUp" && pos.row === 0) {
        const recalled = recallOlder(history, value);
        if (recalled !== null) {
          e.preventDefault();
          setHistory(recalled);
          applyBuffer(recalledText(recalled));
        }
        return; // at the top of a multi-line buffer, the caret stays
      }
      if (e.key === "ArrowDown" && pos.row === lines.length - 1) {
        const recalled = recallNewer(history);
        if (recalled !== null) {
          e.preventDefault();
          setHistory(recalled);
          applyBuffer(recalledText(recalled));
        }
      }
      return;
    }
    if (e.key === "Escape" && busy) {
      // ui-review-r2 P6: an OPEN overlay owns this Esc — the composer's
      // textarea sees the key first (it bubbles to the window listeners
      // after), so without this guard one press both closes the menu AND
      // interrupts the run. The class list matches the shell's real overlay
      // roots: the ctx menu, the palette/picker scrim, the workspace menu's
      // backdrop, the modals.
      if (document.querySelector(".menu, .ctx-backdrop, .search-scrim, .ws-backdrop, .modal, .scrim") !== null) return;
      e.preventDefault();
      onInterrupt();
    }
  };

  // Refocus after any control click kept the flow in the textarea's hands.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // M79b §1: OS drag-drop onto the composer card — a depth counter (not a
  // bare enter/leave pair) so crossing child boundaries never flickers the
  // highlight; the drop collects dataTransfer.files through the SAME
  // admission pre-flight as the picker.
  const onDragEnter = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault(); // without it the browser never fires drop
    setDragOver(true);
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    // ω99-55: a drop splits by kind — images keep their rail (the image
    // lane's own pre-flight refuses non-images with its notice), everything
    // else routes to the file lane (no type whitelist there).
    const dropped = [...(e.dataTransfer?.files ?? [])];
    const images = dropped.filter((f) => f.type.startsWith("image/"));
    const generic = dropped.filter((f) => !f.type.startsWith("image/"));
    if (images.length > 0) addFiles(images);
    if (generic.length > 0) addGenericFiles(generic);
  };

  return (
    <div className="inputarea">
      {menuOpen ? (
        <div
          className="slashmenu"
          role="listbox"
          aria-activedescendant={
            matches[selected] !== undefined ? `${menuId}-opt-${matches[selected].name}` : undefined
          }
        >
          {(() => {
            const { start, rows } = suggestWindow(matches.length, selected);
            const visible = matches.slice(start, start + rows);
            const hidden = matches.length - (start + rows);
            return (
              <>
                {visible.map((c, i) => {
                  const isSelected = start + i === selected;
                  return (
                    <div
                      key={c.name}
                      id={`${menuId}-opt-${c.name}`}
                      className={`row${isSelected ? " sel" : ""}`}
                      role="option"
                      aria-selected={isSelected}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        complete(c.name);
                      }}
                    >
                      {`${isSelected ? "›" : " "}/${c.name}`}
                      {c.args ? <span className="args">{`${c.name.endsWith(":") ? "" : " "}${c.isSensitive === true ? "<redacted>" : c.args}`}</span> : null}
                      {c.description ? <span className="desc">{`  ${c.description}`}</span> : null}
                    </div>
                  );
                })}
                {/* ω99-169: 溢出行中文化（TUI suggest.tsx:49 孪生同串）。 */}
                {hidden > 0 ? <div className="more">{`  … 还有 ${hidden} 项（↓ 滚动）`}</div> : null}
              </>
            );
          })()}
        </div>
      ) : null}
      {/* inkline Task 7 (spec §2): the composer is a 14px-radius tool card —
          borderless textarea on top, the tools row IN-CARD below (chips left:
          the host's prefix + slash + permission mode; `.composer-right` right:
          the suffix widgets + the 28px square-round send). M79b: the image
          rail rides the card's TOP edge (thumbnails above the textarea), and
          the whole card is the drag-drop target. */}
      <div
        className={`composer${dragOver ? " dragover" : ""}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {images.length > 0 ? (
          <div className="img-rail" data-count={images.length}>
            {images.map((d, i) => (
              <div key={d.id} className="img-thumb" data-name={d.name}>
                <img src={d.url} alt={d.name} />
                <button
                  type="button"
                  className="rm"
                  aria-label={sending ? "提交中，暂不能移除" : `移除 ${d.name}`}
                  title={sending ? "提交中，暂不能移除" : `移除 ${d.name}`}
                  disabled={sending}
                  onClick={() => removeImageAt(i)}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {fileDrafts.length > 0 ? (
          <div className="file-rail" data-count={fileDrafts.length}>
            {fileDrafts.map((d, i) => (
              <div key={d.id} className="file-card" data-name={d.name}>
                <span className="glyph" aria-hidden={true}><Icon name="file-text" size={13} /></span>
                <span className="meta">
                  <span className="name">{d.name}</span>
                  <span className="size">{humanSize(d.byteLength)}</span>
                </span>
                <button
                  type="button"
                  className="rm"
                  aria-label={sending ? "提交中，暂不能移除" : `移除 ${d.name}`}
                  title={sending ? "提交中，暂不能移除" : `移除 ${d.name}`}
                  disabled={sending}
                  onClick={() => removeFileDraftAt(i)}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {/* ω99-119: the suggestion chips row — staged files + empty buffer
            (双条件). Zero new CSS: the row rides .composer .file-rail's flex
            layout and the .composer .chip pill (styles.css untouched). */}
        {intentChips.length > 0 ? (
          <div className="file-rail intent-row" data-count={intentChips.length}>
            {intentChips.map((c) => (
              <button
                key={c.label}
                type="button"
                className="chip intent"
                disabled={!connected || sending}
                onClick={() => sendIntent(c.text)}
              >
                {c.label}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={ref}
          className="wudao-input composer-ta"
          value={value}
          rows={growRows(value, colsOf(ref.current))}
          placeholder={
            busy
              ? // ω99-168: fallback 也中文——App 只传 idle，busy 臂生产可见
                // （运行中空框曾显英文 steer the running agent）。
                // 116 弧 C：原「发送 ⏳ 排队」的 emoji 引述退役——排队 chip
                // 已换 hourglass 细线字形，占位文案引「排队」其名不引其形。
                (busyPlaceholder ?? "它在忙，可继续打字插话（发送「排队」）")
              : (idlePlaceholder ?? "吩咐悟道——/ 选命令，@ 引用文件")
          }
          spellCheck={false}
          onChange={(e) => applyValue(e.target.value)}
          // ω99-151: 组合起止落进守卫状态（Safari 的假 Enter 靠 endedAt 时间窗兜）。
          onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
          onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-tools">
          {controlsLead}
          {/* M79b: the 📎 chip is LIVE — it opens the image picker (max 9,
              cumulative ≤ 20MiB, pre-flighted client-side); the count rides
              the chip while drafts are mounted. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = ""; // re-picking the same file re-fires change
            }}
          />
          <input
            ref={fileLaneInputRef}
            type="file"
            data-lane="file"
            multiple
            hidden
            onChange={(e) => {
              addGenericFiles(e.target.files);
              e.target.value = ""; // re-picking the same file re-fires change
            }}
          />
          <button
            type="button"
            className="chip attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={!connected}
            title="添加图片(最多 9 张,总量 ≤ 20MiB;也可直接拖入)"
            aria-label="添加图片"
          >
            <IconPaperclip size={14} />
            {images.length > 0 ? <span className="n">{images.length}</span> : null}
          </button>
          {/* ω99-55: the file lane's chip — any file kind, name+size cards. */}
          <button
            type="button"
            className="chip attachfile"
            onClick={() => fileLaneInputRef.current?.click()}
            disabled={!connected}
            title="添加文件(最多 9 个,总量 ≤ 50MiB;也可直接拖入)"
            aria-label="添加文件"
          >
            <IconFile size={14} />
            {fileDrafts.length > 0 ? <span className="n">{fileDrafts.length}</span> : null}
          </button>
          {controlsPrefix}
          {slashChip === true ? (
            <button type="button" className="chip slash" onClick={onSlashChip} title="命令菜单">
              /
            </button>
          ) : null}
          {/* ω99-316:「顺便问」chip — /btw 侧问的双态入口。armed 后下一条
              文本 submit 走 onSideAsk（旁路：忙时不打断主 run、闲时问一句
              不留痕），发完自动复位。busy/idle 同一入口——旁路的全部意义就
              是不打断。absent keeps the toolbar byte-identical。 */}
          {onSideAsk !== undefined ? (
            <button
              type="button"
              className={`chip sideqa${sideArmed ? " on" : ""}`}
              onClick={() => {
                setSideArmed((v) => !v);
                ref.current?.focus();
              }}
              aria-pressed={sideArmed}
              title="顺便问：不打断主任务，旁路问一句（发送后自动切回主线）"
            >
              顺便问
            </button>
          ) : null}
          {/* 0.3.13: the ONE mode switcher — the ShieldSelector dropdown
              replaces the retired modechip cycle button (two switchers doing
              the same thing was the user's report). shift+tab still cycles
              (the keyboard path lives in the textarea keydown). */}
          <ShieldSelector value={shieldValueOf(mode)} onChange={onShield} disabled={!connected} />
          {/* 输入框下方模型/强度 chips（spec 2026-08-28 §2.1 + 用户反馈
              *  2026-08-28 不要弹窗）：shield 之后。模型 chip 弹
              *  ModelSelector 下拉（强度/模式同款机械）——busy 可切，下一轮
              *  生效，不影响运行中任务。 */}
          {modelLabel != null && modelChoices != null ? (
            <ModelSelector
              label={modelLabel}
              provider={modelProvider}
              choices={modelChoices}
              recent={modelRecent ?? undefined}
              disabled={!connected}
              onPick={(model, provider) => onPickModel?.(model, provider)}
              onPersistDefault={onPersistModelDefault}
            />
          ) : null}
          {efforts != null && efforts.length > 0 ? (
            <EffortSelector
              efforts={efforts}
              current={effort ?? null}
              disabled={!connected}
              onPick={(level) => onPickEffort?.(level)}
              {...(effortProviderLabel !== undefined && onPersistEffortDefault !== undefined
                ? { providerLabel: effortProviderLabel, onPersistDefault: onPersistEffortDefault }
                : {})}
            />
          ) : null}
          {/* ω99-234: #1 — 语言 chip 在此退役（迁设置页·偏好 tab，同一组件）：
              composer 行只留会话内高频旋钮（模型/强度/模式）；跨会话低频偏好
              不占每条消息都扫视的高频面（09-09 用户指令 ④）。 */}
          {busy ? (
            <button type="button" className="chip interrupt" onClick={onInterrupt} disabled={!connected}>
              <IconSlash size={12} />
              {/* ω99-152: 中文动作 + (Esc) 注记，与「保留 (Esc)」同款 */}
              停止 (Esc)
            </button>
          ) : null}
          <div className="composer-right">
            {controlsSuffix}
            <button
              type="button"
              className={`send${value.trim() === "" && images.length === 0 ? " off" : ""}`}
              onClick={() => submit()}
              disabled={!connected || sending || (value.trim() === "" && images.length === 0)}
              aria-label="发送"
            >
              <IconArrowUp size={14} />
            </button>
          </div>
        </div>
      </div>
      {mentionHint !== undefined ? (
        // ω99-152: 说人话——不再写「expanded relative to the workspace root」实现术语
        <div className="hint">{`@${mentionHint} → 发送时会附上（相对工作区根）`}</div>
      ) : null}
      {/* M79b: the image pre-flight's refusal line (over-count / over-budget /
          non-image drop) — transient, cleared by the next clean action. */}
      {imgNotice !== null ? <span className="hint img-notice">{imgNotice}</span> : null}
      {/* M65-space §2: the standing keys hint is gone — the line under the
          composer exists only in its two conditional states (the @-mention
          hint above, and the offline notice below, rendered only while
          disconnected). */}
      {!connected ? (
        <span className="hint">离线——正在等待服务恢复；草稿已保留</span>
      ) : null}
    </div>
  );
}

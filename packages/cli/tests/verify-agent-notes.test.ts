// M73 — tests for the Agent Notes gates: scripts/agent-notes-shared.ts plus
// the two CLIs. Valid/invalid fixture trees are built under os.tmpdir(); the
// tests live in the CLI package's vitest runner because the repo has no
// root-level test home (per-package tests/ is the convention). The final
// block runs both gates against the repository's own corpus.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync , existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGENT_NOTE_CLASSES,
  ALTERNATIVES_GRANDFATHER,
  archiveContentHash,
  checkNoteFormat,
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  verifyActiveNotes,
  walkAgentNoteTree,
  type ArchiveManifest,
} from "../../../scripts/agent-notes-shared.ts";

const tmpTrees: string[] = [];
afterAll(() => {
  for (const tree of tmpTrees) rmSync(tree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A complete skeleton tree (all lifecycles/classes, empty archive manifest). */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "wudao-agent-notes-"));
  tmpTrees.push(root);
  for (const lc of ["proposed", "implemented", "rejected", "archived"]) {
    for (const cls of AGENT_NOTE_CLASSES) mkdirSync(join(root, lc, cls), { recursive: true });
  }
  writeFileSync(join(root, "archived", "README.md"), "# Archived Agent Notes\n");
  writeFileSync(join(root, "archived", "manifest.json"), renderArchiveManifest({}));
  return root;
}

function writeNote(root: string, lifecycle: string, cls: string, name: string, body: string): void {
  writeFileSync(join(root, lifecycle, cls, name), body);
}

const BODY = (sections: string): string =>
  `# Agent Note: A real decision\n\nStatus: STATUS_LINE\n\n${sections}`;
const IMPL = BODY(
  "## Problem\n\nSomething needed deciding.\n\n## Decision\n\nWe decided it.\n\n" +
    "## Alternatives considered\n\n**Do nothing.** It lost because something needed deciding.\n\n" +
    "## Consequences\n\n- The thing is decided.\n",
);
const PROP = IMPL.replace("## Decision", "## Proposal").replace(
  "## Consequences",
  "## Acceptance criteria\n\nIt works.\n\n## Risks\n\nFew.",
);
const REJ = BODY(
  "## Problem\n\nSomething needed deciding.\n\n## Proposal\n\nDo the thing.\n\n" +
    "## Alternatives considered\n\n**Do nothing.** It lost because something needed deciding.\n",
).replace("STATUS_LINE", "rejected — the thing decided itself");

const VALID: Record<string, string> = {
  implemented: IMPL.replace("STATUS_LINE", "implemented"),
  proposed: PROP.replace("STATUS_LINE", "proposed"),
  rejected: REJ,
};

function validTreeWithNotes(): string {
  const root = makeTree();
  writeNote(root, "implemented", "architecture", "2026-01-01-ok.md", VALID.implemented!);
  writeNote(root, "proposed", "feature", "2026-01-02-ok.md", VALID.proposed!);
  writeNote(root, "rejected", "process", "2026-01-03-ok.md", VALID.rejected!);
  return root;
}

describe("M73 §1 — tree walker", () => {
  it("accepts a conforming tree and finds every note", () => {
    const { notes, errors } = walkAgentNoteTree(validTreeWithNotes());
    expect(errors).toEqual([]);
    expect(notes.map((n) => n.rel).sort()).toEqual([
      "implemented/architecture/2026-01-01-ok.md",
      "proposed/feature/2026-01-02-ok.md",
      "rejected/process/2026-01-03-ok.md",
    ]);
  });

  it("rejects an unknown lifecycle folder, an unknown class, a bad filename, and INDEX.md", () => {
    const root = makeTree();
    mkdirSync(join(root, "drafts", "feature"), { recursive: true });
    mkdirSync(join(root, "implemented", "refactor"), { recursive: true });
    writeNote(root, "implemented", "feature", "decision.md", VALID.implemented!);
    writeFileSync(join(root, "INDEX.md"), "# index\n");
    const { errors } = walkAgentNoteTree(root);
    expect(errors.join("\n")).toContain("drafts/");
    expect(errors.join("\n")).toContain("refactor");
    expect(errors.join("\n")).toContain("decision.md");
    expect(errors.join("\n")).toContain("INDEX.md");
  });

  it("rejects a stray file at a lifecycle root and a missing lifecycle folder", () => {
    const root = makeTree();
    writeFileSync(join(root, "implemented", "loose.md"), VALID.implemented!);
    rmSync(join(root, "rejected"), { recursive: true });
    const { errors } = walkAgentNoteTree(root);
    expect(errors.join("\n")).toContain("loose.md");
    expect(errors.join("\n")).toContain("rejected/");
  });

  it("rejects stray files at the notes root (review LOW 1): only README.md may live there", () => {
    const root = makeTree();
    writeFileSync(join(root, "misplaced-note.md"), VALID.implemented!);
    const { errors } = walkAgentNoteTree(root);
    expect(errors.join("\n")).toContain("misplaced-note.md — unexpected file at the notes root");
    // README.md itself stays allowed: rebuild the tree without any stray file.
    const clean = walkAgentNoteTree(validTreeWithNotes());
    expect(clean.errors).toEqual([]);
  });

  it("calendar-validates filename dates (review LOW 2): 2026-13-45 is not a date", () => {
    const root = makeTree();
    writeNote(root, "implemented", "feature", "2026-13-45-bogus.md", VALID.implemented!);
    writeNote(root, "implemented", "feature", "2026-02-30-edge.md", VALID.implemented!);
    writeNote(root, "implemented", "feature", "2024-02-29-leap.md", VALID.implemented!);
    const { notes, errors } = walkAgentNoteTree(root);
    expect(errors.join("\n")).toContain("2026-13-45-bogus.md — filename date 2026-13-45");
    expect(errors.join("\n")).toContain("2026-02-30-edge.md — filename date 2026-02-30");
    expect(notes.map((n) => n.rel)).toEqual(["implemented/feature/2024-02-29-leap.md"]);
  });
});

describe("M73 §2 — format gate", () => {
  it("accepts the three valid lifecycle bodies", () => {
    expect(checkNoteFormat("implemented", VALID.implemented!, "2026-01-01")).toEqual([]);
    expect(checkNoteFormat("proposed", VALID.proposed!, "2026-01-02")).toEqual([]);
    expect(checkNoteFormat("rejected", VALID.rejected!, "2026-01-03")).toEqual([]);
  });

  it("requires the status to agree with the folder", () => {
    const errs = checkNoteFormat("proposed", VALID.implemented!, "2026-01-01");
    expect(errs.join("\n")).toMatch(/proposed status grammar/);
  });

  it("enforces the exact 3-line header", () => {
    const badTitle = VALID.implemented!.replace("# Agent Note: A real decision", "# A real decision");
    const noBlank = VALID.implemented!.replace("\n\nStatus:", "\nStatus:");
    for (const bad of [badTitle, noBlank]) {
      expect(checkNoteFormat("implemented", bad, "2026-01-01").length).toBeGreaterThan(0);
    }
  });

  it("rejects a second Status line in the body", () => {
    const dup = VALID.implemented!.replace("## Problem", "Status: implemented\n\n## Problem");
    expect(checkNoteFormat("implemented", dup, "2026-01-01").join("\n")).toContain("only one");
  });

  it("requires each lifecycle's skeleton and rejects proposal-era headings in implemented notes", () => {
    const missingDecision = VALID.implemented!.replace("## Decision\n\nWe decided it.\n\n", "");
    expect(checkNoteFormat("implemented", missingDecision, "2026-01-01").join("\n")).toContain(
      "missing the required `## Decision`",
    );
    const planSpeak = VALID.implemented!.replace(
      "## Consequences",
      "## Migration plan\n\nStep one.\n\n## Consequences",
    );
    expect(checkNoteFormat("implemented", planSpeak, "2026-01-01").join("\n")).toContain(
      "proposal-era heading",
    );
  });

  it("mandates Alternatives considered, with the grandfather comment only for pre-format notes", () => {
    const none = VALID.implemented!.replace(
      "## Alternatives considered\n\n**Do nothing.** It lost because something needed deciding.\n\n",
      "",
    );
    expect(checkNoteFormat("implemented", none, "2026-01-01").join("\n")).toContain(
      "missing `## Alternatives considered`",
    );
    const grandfathered = none.replace("## Consequences", `${ALTERNATIVES_GRANDFATHER}\n\n## Consequences`);
    expect(checkNoteFormat("implemented", grandfathered, "2026-01-01")).toEqual([]);
    expect(checkNoteFormat("implemented", grandfathered, "2026-12-31").join("\n")).toContain(
      "only valid for Agent Notes dated before",
    );
    const both = VALID.implemented!.replace("## Consequences", `${ALTERNATIVES_GRANDFATHER}\n\n## Consequences`);
    expect(checkNoteFormat("implemented", both, "2026-01-01").join("\n")).toContain("drop the comment");
  });

  it("ignores format tokens inside fenced code blocks", () => {
    const fenced = VALID.implemented!.replace(
      "## Consequences",
      "```\n## Proposal (example)\n```\n\n## Consequences",
    );
    expect(checkNoteFormat("implemented", fenced, "2026-01-01")).toEqual([]);
  });
});

describe("M73 §2 — verifyActiveNotes end-to-end on a tree", () => {
  it("returns zero errors for a conforming tree and counts the notes", () => {
    const { noteCount, errors } = verifyActiveNotes(validTreeWithNotes());
    expect(errors).toEqual([]);
    expect(noteCount).toBe(3);
  });

  it("aggregates per-note violations with the note path", () => {
    const root = makeTree();
    writeNote(root, "implemented", "feature", "2026-01-01-bad.md", VALID.proposed!); // wrong skeleton + status
    const { errors } = verifyActiveNotes(root);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.startsWith("format: implemented/feature/2026-01-01-bad.md —"))).toBe(true);
  });
});

describe("M73 §3 — archive manifest", () => {
  it("parses and renders with deterministic ordering", () => {
    const files = { "b/x.md": "sha256:" + "b".repeat(64), "a/y.md": "sha256:" + "a".repeat(64) };
    const rendered = renderArchiveManifest(files);
    expect(rendered.indexOf("a/y.md")).toBeLessThan(rendered.indexOf("b/x.md"));
    expect(parseArchiveManifest(rendered).files).toEqual(files);
  });

  it("rejects manifests outside the closed schema", () => {
    expect(() => parseArchiveManifest("[]")).toThrow("expected a JSON object");
    expect(() => parseArchiveManifest('{"version":2,"files":{}}')).toThrow("version");
    expect(() => parseArchiveManifest('{"version":1,"files":{},"extra":1}')).toThrow("fields");
    expect(() => parseArchiveManifest('{"version":1,"files":{"a.md":"md5:xx"}}')).toThrow("hash");
  });

  it("flags changed and missing sealed entries (append-only proof, part 1)", () => {
    const baseline: ArchiveManifest = { version: 1, files: { "a.md": "sha256:" + "1".repeat(64) } };
    const changed: ArchiveManifest = { version: 1, files: { "a.md": "sha256:" + "2".repeat(64) } };
    const removed: ArchiveManifest = { version: 1, files: {} };
    expect(validateArchiveManifestExtension(baseline, changed)).toEqual(["a.md: sealed manifest hash changed"]);
    expect(validateArchiveManifestExtension(baseline, removed)).toEqual(["a.md: sealed manifest entry is missing"]);
    expect(validateArchiveManifestExtension(baseline, baseline)).toEqual([]);
  });

  it("proves every seal then appends only new hashes (append-only proof, part 2)", () => {
    const content = Buffer.from("frozen");
    const sealed = "sha256:" + "9".repeat(64);
    const tampered = Buffer.from("edited");
    const result = extendArchiveManifest(
      { version: 1, files: { "a.md": sealed } },
      new Map([
        ["a.md", tampered],
        ["b.md", content],
      ]),
    );
    expect(result.errors).toEqual(["a.md: sealed content hash changed"]);
    expect(result.added).toEqual(["b.md"]);
    expect(result.files["b.md"]).toBe(archiveContentHash(content));
    expect(result.files["a.md"]).toBe(sealed);
  });
});

describe("M73 §3 — sealed artifact validation", () => {
  const SEALED = (archivedDate: string): Buffer =>
    Buffer.from(
      `# Agent Note: Sealed\n\nStatus: implemented\nArchived: ${archivedDate}\n\n## Problem\n\nDone.\n`,
    );

  it("accepts a well-formed sealed note", () => {
    const artifacts = new Map([["architecture/2026-01-05-done.md", SEALED("2026-02-01")]]);
    expect(validateArchiveArtifacts(artifacts)).toEqual([]);
  });

  it("requires the frozen header and a plausible archive date", () => {
    const noDate = Buffer.from("# Agent Note: Sealed\n\nStatus: implemented\n\n## Problem\n\nDone.\n");
    expect(validateArchiveArtifacts(new Map([["feature/2026-01-01-x.md", noDate]]))[0]).toContain("Archived:");
    const early = validateArchiveArtifacts(
      new Map([["feature/2026-05-05-late.md", SEALED("2026-01-01")]]),
    );
    expect(early[0]).toContain("predates");
  });

  it("rejects companions sealed without their note and unknown classes", () => {
    const zh = Buffer.from("# Agent Note: Sealed\n\nStatus: implemented\n\nArchived: 2026-02-01\n\n## Problem\n\n");
    const errs = validateArchiveArtifacts(
      new Map([
        ["architecture/2026-01-05-orphan.zh.md", zh],
        ["cosplay/2026-01-05-x.md", zh],
      ]),
    );
    expect(errs.join("\n")).toContain("without their note file");
    expect(errs.join("\n")).toContain("unknown Agent Note class");
  });
});

describe("M73 §2-3 — the CLIs against fixture trees and the repo corpus", () => {
  const script = (name: string): string =>
    fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url));
  const repoNotes = fileURLToPath(new URL("../../../.agents/notes", import.meta.url));

  function run(scriptName: string, args: string[]): { status: number; output: string } {
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", script(scriptName), ...args],
        { encoding: "utf8", stderr: "pipe" },
      );
      return { status: 0, output: stdout };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("verify-agent-notes exits 0 on a conforming tree and 1 on a violated one", () => {
    expect(run("verify-agent-notes.ts", ["--root", validTreeWithNotes()]).status).toBe(0);
    const bad = makeTree();
    writeNote(bad, "implemented", "feature", "2026-01-01-bad.md", VALID.proposed!);
    const result = run("verify-agent-notes.ts", ["--root", bad]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("violations found");
  });

  it("verify-agent-notes rejects unknown flags", () => {
    expect(run("verify-agent-notes.ts", ["--bogus"]).status).toBe(2);
  });

  // 开源仓不携带 .agents/notes（内部开发流程档案）——公开树 skip，内部树全钉。
  it.skipIf(!existsSync(repoNotes))("the repository's own corpus passes both gates", () => {
    const active = run("verify-agent-notes.ts", ["--root", repoNotes]);
    expect(active.status).toBe(0);
    expect(active.output).toMatch(/Agent Note\(s\) checked/);
    const archive = run("verify-archived-agent-notes.ts", ["--root", repoNotes]);
    expect(archive.status).toBe(0);
  });
});

describe("M73 §3 review LOW 3 — the archived CLI end-to-end in a tmp git repo", () => {
  const scriptPath = fileURLToPath(new URL("../../../scripts/verify-archived-agent-notes.ts", import.meta.url));

  function run(root: string, ...flags: string[]): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, ["--experimental-strip-types", scriptPath, "--root", root, ...flags], {
        encoding: "utf8",
      });
      return { status: 0, output: stdout };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
  }

  it("seals on --write, refuses to re-seal tampered content, and exits nonzero on violations", () => {
    // A real (scratch) git repository so the CLI's baseline manifest read —
    // `git show <ref>:...` against WUDAO_ARCHIVE_BASE_REF ?? HEAD — is exercised.
    const repo = mkdtempSync(join(tmpdir(), "wudao-archive-cli-"));
    tmpTrees.push(repo);
    const notes = join(repo, ".agents", "notes");
    for (const lc of ["implemented", "archived"]) {
      for (const cls of AGENT_NOTE_CLASSES) mkdirSync(join(notes, lc, cls), { recursive: true });
    }
    for (const lc of ["proposed", "rejected"]) for (const cls of AGENT_NOTE_CLASSES) mkdirSync(join(notes, lc, cls), { recursive: true });
    writeFileSync(join(notes, "archived", "README.md"), "# Archived Agent Notes\n");
    writeFileSync(join(notes, "archived", "manifest.json"), renderArchiveManifest({}));
    const active = join(notes, "implemented", "architecture", "2026-03-01-to-archive.md");
    const sealed = join(notes, "archived", "architecture", "2026-03-01-to-archive.md");
    writeFileSync(
      active,
      "# Agent Note: To archive\n\nStatus: implemented\n\n## Problem\n\nDone.\n\n## Decision\n\nIt shipped.\n\n" +
        "## Alternatives considered\n\n**Nothing.** It lost.\n\n## Consequences\n\n- Done.\n",
    );
    git(repo, "init", "-q");
    // Byte-faithful blobs: an operator's global core.autocrlf=true smudges
    // LF→CRLF on every `git show`, breaking the seal hashes.
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "add", ".agents");
    git(repo, "commit", "-qm", "baseline");

    // The archival change: move the note, insert the one permitted line.
    renameSync(active, sealed);
    let text = readFileSync(sealed, "utf8");
    writeFileSync(sealed, text.replace("Status: implemented\n", "Status: implemented\nArchived: 2026-03-05\n"));

    // Unsealed → read fails; --write proves nothing exists yet, seals exactly one.
    expect(run(notes).status).toBe(1);
    expect(run(notes).output).toContain("not sealed in manifest.json");
    const write = run(notes, "--write");
    expect(write.status).toBe(0);
    expect(write.output).toContain("sealed 1 new artifact(s); existing seals unchanged");
    expect(run(notes).status).toBe(0);
    expect(parseArchiveManifest(readFileSync(join(notes, "archived", "manifest.json"), "utf8")).files).toHaveProperty(
      "architecture/2026-03-01-to-archive.md",
    );
    git(repo, "add", ".agents");
    git(repo, "commit", "-qm", "sealed");

    // Tamper with the sealed artifact: read fails, and --write must NOT bypass
    // the seal proof (prove-every-seal runs before any append).
    text = readFileSync(sealed, "utf8");
    writeFileSync(sealed, `${text}\nsneaky edit\n`);
    const tamperedRead = run(notes);
    expect(tamperedRead.status).toBe(1);
    expect(tamperedRead.output).toContain("sealed content hash changed");
    const tamperedWrite = run(notes, "--write");
    expect(tamperedWrite.status).toBe(1);
    expect(tamperedWrite.output).toContain("sealed content hash changed");

    // Restoring the bytes clears the violation (the manifest itself never moved).
    git(repo, "checkout", "-q", "--", ".agents/notes/archived/architecture/2026-03-01-to-archive.md");
    expect(run(notes).status).toBe(0);
  });
});

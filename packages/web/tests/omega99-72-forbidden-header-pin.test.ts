// ω99-72 — FORBIDDEN_HEADER_KEYS mirror-consistency pin. The web form's
// hand-mirrored key set (packages/web/src/persona-schema.ts) and the
// providers single source (packages/providers/src/header-validation.ts since
// ω99-69; persona/schema.ts only re-exports it) must hold the SAME 14 keys
// forever. There is no runtime import edge BY DESIGN (the web package never
// depends on @wudao/providers — pulling the Node-side providers package into
// the frontend's dependency graph for 14 strings was ruled out), so the
// consistency check runs at TEST time: the web export is imported (the real
// form surface) and the providers source is readFileSync'd to extract the
// single-source keys (the ω99-67 source-pin technique — text-level coupling,
// accepted there and here; a definition-shape change on either side must be
// carried into this pin deliberately, never silently). The comparison is
// symmetric, so it catches BOTH drift directions: a key missing from the
// mirror means the form lets users type a header the server will refuse; an
// orphan key on the mirror side means the form red-texts a header the server
// already accepts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_HEADER_KEYS as WEB_MIRROR } from "../src/persona-schema.js";

// Path note: fileURLToPath(import.meta.url) is the FILE path (…/web/tests/
// this.test.ts), so each "../" first eats the filename — "../../.." reaches
// packages/, one more "../" than the directory-based intuition.
const PROVIDERS_SINGLE_SOURCE = join(fileURLToPath(import.meta.url), "../../../providers/src/header-validation.ts");
const WEB_MIRROR_SOURCE = join(fileURLToPath(import.meta.url), "../../src/persona-schema.ts");

/** Extract the FORBIDDEN_HEADER_KEYS definition block's string literals from
 * a source file (ω99-67 form: locate the declaration, slice to its closing
 * `]);`, match the quoted keys). Every step fails loudly — a missing or
 * malformed block is itself a red, not an empty pass. */
function forbiddenKeysFromSource(path: string, label: string): readonly string[] {
  const src = readFileSync(path, "utf8");
  const decl = src.indexOf("export const FORBIDDEN_HEADER_KEYS");
  expect(decl, `${label}: no 'export const FORBIDDEN_HEADER_KEYS' declaration found`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("]);", decl);
  expect(end, `${label}: FORBIDDEN_HEADER_KEYS block not closed by ']);'`).toBeGreaterThan(decl);
  const keys = [...src.slice(decl, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  expect(keys.length, `${label}: extracted an empty key set — definition shape drifted`).toBeGreaterThan(0);
  return keys;
}

describe("ω99-72 FORBIDDEN_HEADER_KEYS: web mirror = providers single source", () => {
  it("runtime mirror deep-equals the providers single source (exactly 14 keys)", () => {
    const providerKeys = forbiddenKeysFromSource(PROVIDERS_SINGLE_SOURCE, "providers/src/header-validation.ts");
    expect(providerKeys.length, "providers single-source key count").toBe(14);
    expect(new Set(providerKeys).size, "providers single-source has duplicate keys").toBe(14);
    expect(WEB_MIRROR.size, "web mirror key count").toBe(14);
    expect([...WEB_MIRROR].sort()).toEqual([...providerKeys].sort());
  });

  it("web SOURCE block carries no orphan keys outside the providers block (and vice versa)", () => {
    const providerKeys = forbiddenKeysFromSource(PROVIDERS_SINGLE_SOURCE, "providers/src/header-validation.ts");
    const webSourceKeys = forbiddenKeysFromSource(WEB_MIRROR_SOURCE, "web/src/persona-schema.ts");
    expect(webSourceKeys.length, "web mirror source key count").toBe(14);
    expect(new Set(webSourceKeys).size, "web mirror source has duplicate keys").toBe(14);
    expect([...webSourceKeys].sort()).toEqual([...providerKeys].sort());
  });
});

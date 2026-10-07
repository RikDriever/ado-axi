import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/auth.js", () => ({ resolveCredential: vi.fn(async () => ({ header: "Bearer test" })) }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn(async () => undefined) }));

import { apiCommand } from "../src/commands/api.js";
import { resolveCredential } from "../src/lib/auth.js";

let dir: string;
const mockCredential = vi.mocked(resolveCredential);
const mockFetch = vi.fn();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ado-axi-api-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    defaultProfile: "other",
    profiles: {
      other: { org: "other-org", project: "Wrong Project", auth: "az" },
      acme: { org: "acme", project: "Default Project", auth: "pat", patEnv: "ACME_PAT" },
    },
  }));
  vi.stubEnv("ADO_AXI_CONFIG", file);
  vi.stubEnv("ADO_AXI_ORG", "other-org");
  vi.stubEnv("ADO_AXI_PROJECT", "Environment Project");
  mockCredential.mockClear();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ value: [] }), { status: 200 }));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("api URL context", () => {
  it.each(["dev.azure.com", "vsrm.dev.azure.com", "vssps.dev.azure.com", "almsearch.dev.azure.com"])(
    "uses URL context and matching profile auth on %s",
    async (host) => {
      const url = `https://${host}/acme/URL%20Project/_apis/example/items?api-version=7.1-preview.1`;
      const result = await apiCommand(["GET", url, "--query", "name=a%26b"]);
      expect(mockFetch.mock.calls[0]?.[0]).toBe(`${url}&name=a%26b`);
      expect(mockCredential).toHaveBeenCalledWith(expect.objectContaining({
        org: "acme", project: "URL Project", auth: "pat", patEnv: "ACME_PAT",
      }));
      expect(result.request).toEqual({ method: "GET", url: `${url}&name=a%26b` });
    },
  );

  it("keeps an org-level URL org-level despite environment and profile projects", async () => {
    await apiCommand(["https://dev.azure.com/acme/_apis/projects"]);
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://dev.azure.com/acme/_apis/projects?api-version=7.1");
    expect(mockCredential).toHaveBeenCalledWith(expect.objectContaining({ org: "acme", project: undefined }));
  });

  it("accepts matching explicit selectors and preserves a mutation body", async () => {
    const body = [{ op: "test", path: "/rev", value: 7 }];
    await apiCommand([
      "PATCH", "https://dev.azure.com/acme/Project/_apis/wit/workitems/42",
      "--org", "https://dev.azure.com/acme", "--project", "Project", "--profile", "acme", "--host", "dev",
      "--content-type", "json-patch", "--body", JSON.stringify(body),
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/acme/Project/_apis/wit/workitems/42?api-version=7.1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(body), headers: expect.objectContaining({
        "Content-Type": "application/json-patch+json",
      }) }),
    );
  });

  it.each([
    ["--org", "other-org"], ["--project", "Other"], ["--host", "vsrm"],
    ["--profile", "other"], ["--no-project"], ["--api-version", "6.0"],
    ["--query", "api-version=6.0"], ["--limit", "5"],
  ])("rejects conflicting flags %j before acquiring credentials", async (...flags) => {
    await expect(apiCommand([
      "https://dev.azure.com/acme/Project/_apis/example/items?api-version=7.1&$top=10", ...flags,
    ])).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("conflicts") });
    expect(mockCredential).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects --project on an org-level URL rather than changing scope", async () => {
    await expect(apiCommand(["https://dev.azure.com/acme/_apis/projects", "--project", "Project"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR", message: expect.stringContaining("--project conflicts"),
    });
    expect(mockCredential).not.toHaveBeenCalled();
  });

  it("still accepts relative paths containing slashes and an org URL", async () => {
    await apiCommand(["_apis/wiki/wikis", "--org", "https://dev.azure.com/acme", "--project", "Project"]);
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://dev.azure.com/acme/Project/_apis/wiki/wikis?api-version=7.1");
  });
});

describe("api URL validation", () => {
  it.each([
    "https://example.com/acme/Project/_apis/projects",
    "https://dev.azure.com.example.com/acme/_apis/projects",
    "http://dev.azure.com/acme/_apis/projects",
    "https:dev.azure.com/acme/../other-org/_apis/projects",
    "https:///dev.azure.com/acme/../other-org/_apis/projects",
    "https://user:password@dev.azure.com/acme/_apis/projects",
    "https://dev.azure.com:8443/acme/_apis/projects",
    "https://dev.azure.com/acme/_apis/projects#fragment",
    "https://dev.azure.com/acme/_apis/projects?api-version=6.0&api-version=7.1",
    "https://dev.azure.com/acme/Project/_git/repo",
    "https://dev.azure.com/acme/Project/%2e%2e/_apis/projects",
    "https://dev.azure.com/acme/Project%2FOther/_apis/projects",
    "https://dev.azure.com/acme/Project%ZZ/_apis/projects",
    "//example.com/_apis/projects",
    "C:\\Program Files\\Git\\_apis\\projects",
    "../other-org/_apis/projects",
  ])("rejects unsafe or malformed input %s locally", async (input) => {
    await expect(apiCommand([input])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockCredential).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { buildUrl, request, type AdoHost } from "../lib/client.js";
import { ADO_HOSTS, normalizeOrg, parseAdoApiUrl } from "../lib/adoUrl.js";
import { resolveProfile } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { truncate } from "../lib/format.js";
import { readStdinIfPiped } from "../lib/stdin.js";

const API_FLAGS = [
  "method",
  "body",
  "query",
  "api-version",
  "host",
  "no-project",
  "raw",
  "limit",
  "content-type",
];
const HOSTS = Object.keys(ADO_HOSTS);
const CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  "json-patch": "application/json-patch+json",
  "merge-patch": "application/merge-patch+json",
  text: "text/plain",
};

function assertUrlMatch(flag: string, value: string | undefined, expected: string | undefined): void {
  if (value !== undefined && value.toLowerCase() !== expected?.toLowerCase()) {
    throw new AxiError(`--${flag} conflicts with the API URL`, "VALIDATION_ERROR", [
      `Remove --${flag} or use a URL with matching context; URL context is never silently overridden`,
    ]);
  }
}

export async function apiCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, API_FLAGS, "api");

  let method = flagString(args, "method")?.toUpperCase();
  let path = args.positionals[0];
  if (path && /^(GET|POST|PATCH|PUT|DELETE)$/i.test(path)) {
    method = path.toUpperCase();
    path = args.positionals[1];
  }
  if (!path) {
    throw new AxiError("an API path is required", "VALIDATION_ERROR", [
      "Usage: ado-axi api [GET|POST|PATCH|PUT|DELETE] <path|url> [--body '<json>'] [--query 'k=v&k2=v2']",
      "Example: ado-axi api _apis/wiki/wikis",
      "Example: ado-axi api POST _apis/wit/wiql --body '{\"query\":\"SELECT [System.Id] FROM WorkItems\"}'",
      "Use a relative path (--no-project for org-level paths) or a full HTTPS Azure DevOps REST URL",
      `Work item writes need JSON-Patch: --content-type json-patch --body '[{"op":"add","path":"/fields/System.State","value":"Active"}]'`,
    ]);
  }

  const apiUrl = parseAdoApiUrl(path);
  const host = (flagString(args, "host") ?? apiUrl?.host ?? "dev") as AdoHost;
  if (!HOSTS.includes(host)) {
    throw new AxiError(`unknown --host '${host}'`, "VALIDATION_ERROR", [
      `Valid hosts: ${HOSTS.join(", ")}`,
    ]);
  }

  if (apiUrl) {
    const org = flagString(args, "org");
    assertUrlMatch("org", org === undefined ? undefined : normalizeOrg(org), apiUrl.org);
    assertUrlMatch("project", flagString(args, "project"), apiUrl.project);
    assertUrlMatch("host", flagString(args, "host"), apiUrl.host);
    if (flagBool(args, "no-project") && apiUrl.project !== undefined) {
      throw new AxiError("--no-project conflicts with the project in the API URL", "VALIDATION_ERROR", [
        "Remove --no-project or use an organization-level API URL",
      ]);
    }
    path = apiUrl.path;
  }

  const profile = apiUrl
    ? resolveProfile({
        profile: flagString(args, "profile"),
        org: flagString(args, "profile") ? undefined : apiUrl.org,
        project: apiUrl.project,
      })
    : profileFromArgs(args);
  if (apiUrl) {
    assertUrlMatch("profile", profile.org, apiUrl.org);
    profile.project = apiUrl.project;
  }

  const query: Record<string, string> = Object.assign(Object.create(null), apiUrl?.query);
  const setQuery = (key: string, value: string, flag: string): void => {
    if (apiUrl && Object.hasOwn(apiUrl.query, key) && apiUrl.query[key] !== value) {
      throw new AxiError(`--${flag} conflicts with '${key}' in the API URL`, "VALIDATION_ERROR", [
        `Remove --${flag} or update the URL query to match`,
      ]);
    }
    query[key] = value;
  };
  const rawQuery = flagString(args, "query");
  if (rawQuery) {
    for (const [key, value] of new URLSearchParams(rawQuery)) setQuery(key, value, "query");
  }
  const limit = flagNumber(args, "limit");
  if (limit !== undefined) setQuery("$top", String(limit), "limit");
  const apiVersion = flagString(args, "api-version");
  if (apiUrl && apiVersion !== undefined) setQuery("api-version", apiVersion, "api-version");

  let body: unknown;
  const rawBody = flagString(args, "body");
  const stdinBody = rawBody === undefined ? await readStdinIfPiped() : undefined;
  if (rawBody !== undefined) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new AxiError("--body expects valid JSON", "VALIDATION_ERROR", [
        `Example: --body '{"query":"SELECT [System.Id] FROM WorkItems"}'`,
      ]);
    }
  } else if (stdinBody !== undefined) {
    body = stdinBody;
  }

  let contentType: string | undefined;
  const rawContentType = flagString(args, "content-type");
  if (rawContentType) {
    contentType = CONTENT_TYPES[rawContentType] ?? rawContentType;
    if (!contentType.includes("/")) {
      throw new AxiError(`unknown --content-type '${rawContentType}'`, "VALIDATION_ERROR", [
        `Shorthands: ${Object.keys(CONTENT_TYPES).join(", ")} — or pass a full media type`,
      ]);
    }
  }

  const options = {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    path,
    project: flagBool(args, "no-project") ? undefined : profile.project,
    query,
    body,
    apiVersion,
    contentType,
    host,
    raw: flagBool(args, "raw"),
  };

  const url = buildUrl(profile, options);
  const result = await request<unknown>(profile, options);

  if (typeof result === "string") {
    const text = truncate(result, flagBool(args, "full") ? Number.MAX_SAFE_INTEGER : 4000);
    return { request: { method: options.method, url }, response: text.text };
  }

  const payload = result as Record<string, unknown> | null;
  const out: Record<string, unknown> = { request: { method: options.method, url } };
  if (payload && typeof payload === "object" && Array.isArray((payload as { value?: unknown[] }).value)) {
    const value = (payload as { value: unknown[]; count?: number }).value;
    out.count = (payload as { count?: number }).count ?? value.length;
    out.value = value;
  } else {
    out.response = payload ?? "(empty response, the request succeeded)";
  }
  return out;
}

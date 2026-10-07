import { AxiError } from "axi-sdk-js";

export const ADO_HOSTS = {
  dev: "dev.azure.com",
  vsrm: "vsrm.dev.azure.com",
  vssps: "vssps.dev.azure.com",
  almsearch: "almsearch.dev.azure.com",
} as const;

export type AdoHost = keyof typeof ADO_HOSTS;

function urlError(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [
    "Use an HTTPS Azure DevOps REST URL on dev.azure.com, vsrm.dev.azure.com, vssps.dev.azure.com, or almsearch.dev.azure.com",
    "Or pass a relative API path with --org <org> [--project <project>] [--host <host>]",
  ]);
}

function parseUrl(input: string): URL {
  if (!/^https:\/\/[^/?#]+/i.test(input) || input !== input.trim() || /[\\\u0000-\u001f\u007f]/.test(input)) {
    urlError("invalid Azure DevOps URL");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return urlError("invalid Azure DevOps URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || input.includes("#")) {
    urlError("Azure DevOps URLs require HTTPS without credentials, custom ports, or fragments");
  }
  const rawPath = input.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] ?? "";
  assertRelativeApiPath(rawPath);
  return url;
}

export function normalizeOrg(input: string): string {
  if (/^[a-z0-9][a-z0-9-]*$/i.test(input)) return input;
  if (/^https:\/\//i.test(input)) {
    const url = parseUrl(input);
    let org: string | undefined;
    if (url.hostname === ADO_HOSTS.dev) {
      org = /^\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(url.pathname)?.[1];
    } else {
      org = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i.exec(url.hostname)?.[1];
      if (url.pathname !== "/") org = undefined;
    }
    if (org && !url.search) return org;
  }
  throw new AxiError("organization must be a name or an Azure DevOps organization-root URL", "VALIDATION_ERROR", [
    "Use --org acme, --org https://dev.azure.com/acme, or --org https://acme.visualstudio.com",
    "Pass the project separately with --project <project>; do not include project or API paths in --org",
  ]);
}

export function assertRelativeApiPath(path: string): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) {
    urlError("expected a relative API path, not a URL or Windows path");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return urlError("API path contains invalid percent encoding");
  }
  if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === "..")) {
    urlError("API paths must not contain backslashes or dot segments");
  }
}

export interface AdoApiUrl {
  org: string;
  project?: string;
  host: AdoHost;
  path: string;
  query: Record<string, string>;
}

export function parseAdoApiUrl(input: string): AdoApiUrl | undefined {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    assertRelativeApiPath(input);
    return undefined;
  }
  const url = parseUrl(input);
  const host = (Object.keys(ADO_HOSTS) as AdoHost[]).find((key) => ADO_HOSTS[key] === url.hostname);
  if (!host) urlError("unsupported Azure DevOps API URL host");
  const segments = url.pathname.slice(1).split("/");
  const apiIndex = segments.indexOf("_apis");
  if (apiIndex < 1 || !segments[apiIndex + 1]) {
    urlError("expected an Azure DevOps REST URL containing /_apis/<resource>");
  }
  const org = normalizeOrg(segments[0] ?? "");
  const project = apiIndex > 1 ? decodeURIComponent(segments[1] ?? "") : undefined;
  if (project !== undefined && (!project || /[/\\]/.test(project))) {
    urlError("invalid project segment in Azure DevOps API URL");
  }
  const query = Object.fromEntries(url.searchParams);
  if (Object.keys(query).length !== url.searchParams.size) {
    urlError("duplicate query parameters in the API URL are not supported");
  }
  return {
    org,
    project,
    host,
    path: segments.slice(project === undefined ? 1 : 2).join("/"),
    query,
  };
}

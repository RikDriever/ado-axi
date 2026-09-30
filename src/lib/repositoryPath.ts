import { AxiError } from "axi-sdk-js";

function gitBashRoot(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.MSYSTEM) return undefined;
  const exePath = env.EXEPATH?.replace(/\\/g, "/").replace(/\/+$/, "");
  return exePath ? exePath.replace(/\/(usr\/)?bin$/i, "") : "C:/Program Files/Git";
}

export function normalizeRepositoryPath(
  path: string,
  flag = "--file",
  retryCommand = "ado-axi pr comment ...",
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[a-z]:[\\/]/i.test(path)) return path;
  const root = gitBashRoot(env);
  const forward = path.replace(/\\/g, "/");
  if (root) {
    const lower = forward.toLowerCase();
    const rootLower = root.toLowerCase();
    if (lower.startsWith(`${rootLower}/`) && !lower.startsWith(`${rootLower}/usr/bin/`)) {
      return forward.slice(root.length);
    }
  }
  throw new AxiError(`${flag} received a Windows path: ${path}`, "VALIDATION_ERROR", [
    "Git Bash may have converted the Azure DevOps repository path",
    `Retry with \`MSYS_NO_PATHCONV=1 ${retryCommand}\``,
    "Repository paths must look like `/src/Project/File.cs`",
  ]);
}

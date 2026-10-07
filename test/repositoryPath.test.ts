import { describe, expect, it } from "vitest";
import { normalizeRepositoryPath } from "../src/lib/repositoryPath.js";

const gitBash = { MSYSTEM: "MINGW64", EXEPATH: "C:\\Program Files\\Git\\bin" };

describe("normalizeRepositoryPath", () => {
  it("accepts Azure DevOps repository paths", () => {
    expect(normalizeRepositoryPath("/src/Project/File.cs", "--file", "ado-axi pr comment ...", gitBash)).toBe(
      "/src/Project/File.cs",
    );
  });

  it.each([
    ["C:/Program Files/Git/src/Project/File.cs", gitBash],
    ["C:\\Program Files\\Git\\src\\Project\\File.cs", gitBash],
    ["C:/Program Files/Git/src/Project/File.cs", { MSYSTEM: "MINGW64" }],
    ["D:/Tools/Git/src/Project/File.cs", { MSYSTEM: "MINGW64", EXEPATH: "D:\\Tools\\Git" }],
  ])("undoes the Git Bash path conversion of %s", (path, env) => {
    expect(normalizeRepositoryPath(path, "--file", "ado-axi pr comment ...", env)).toBe("/src/Project/File.cs");
  });

  it.each([
    ["C:/Users/me/Project/File.cs", gitBash],
    ["C:/Program Files/Git/usr/bin/App.cs", gitBash],
    ["C:\\Program Files\\Git\\usr\\bin\\App.cs", gitBash],
    ["C:/Program Files/Git/src/Project/File.cs", {}],
  ])("rejects other Windows paths before posting a comment", (path, env) => {
    try {
      normalizeRepositoryPath(path, "--file", "ado-axi pr comment ...", env);
      throw new Error("expected validation error");
    } catch (error) {
      expect((error as { message: string }).message).toMatch(/Windows path/);
      expect((error as { suggestions: string[] }).suggestions).toContain(
        "Retry with `MSYS_NO_PATHCONV=1 ado-axi pr comment ...`",
      );
    }
  });
});

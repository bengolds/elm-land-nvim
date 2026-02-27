import { describe, test, expect } from "bun:test";
import * as path from "path";
import { parseElmJson, findElmJsonFor, uriToPath, pathToUri } from "../src/project/elm-json";
import { getElmHome } from "../src/project/elm-home";
import { resolveModuleToFile } from "../src/project/module-resolver";
import { SMALL_PROJECT } from "./helpers";

describe("elm-json", () => {
  test("parseElmJson parses valid application elm.json", () => {
    const raw = JSON.stringify({
      type: "application",
      "elm-version": "0.19.1",
      "source-directories": ["src"],
      dependencies: { direct: { "elm/core": "1.0.5" }, indirect: {} },
    });
    const result = parseElmJson("/tmp/proj/elm.json", raw);
    expect(result).not.toBeUndefined();
    expect(result!.elmVersion).toBe("0.19.1");
    expect(result!.sourceDirectories).toEqual(["/tmp/proj/src"]);
    expect(result!.dependencies.length).toBe(1);
    expect(result!.dependencies[0]!.packageUserAndName).toBe("elm/core");
  });

  test("parseElmJson returns undefined for invalid JSON", () => {
    expect(parseElmJson("/tmp/elm.json", "not json")).toBeUndefined();
  });

  test("parseElmJson returns undefined for missing fields", () => {
    expect(parseElmJson("/tmp/elm.json", JSON.stringify({ type: "app" }))).toBeUndefined();
  });

  test("findElmJsonFor finds elm.json from source file", async () => {
    const filePath = path.join(SMALL_PROJECT, "src", "Main.elm");
    const result = await findElmJsonFor(filePath);
    expect(result).not.toBeUndefined();
    expect(result!.projectFolder).toBe(SMALL_PROJECT);
    expect(result!.sourceDirectories).toContain(path.join(SMALL_PROJECT, "src"));
  });

  test("findElmJsonFor returns undefined outside project", async () => {
    const result = await findElmJsonFor("/tmp/no-project-here/File.elm");
    expect(result).toBeUndefined();
  });

  test("dependency docs paths resolve correctly", () => {
    const raw = JSON.stringify({
      type: "application",
      "elm-version": "0.19.1",
      "source-directories": ["src"],
      dependencies: { direct: { "elm/core": "1.0.5" }, indirect: {} },
    });
    const result = parseElmJson("/tmp/proj/elm.json", raw);
    const dep = result!.dependencies[0]!;
    expect(dep.docsPath).toContain("0.19.1/packages/elm/core/1.0.5/docs.json");
  });
});

describe("elm-home", () => {
  test("getElmHome returns a path", () => {
    const home = getElmHome();
    expect(typeof home).toBe("string");
    expect(home.length).toBeGreaterThan(0);
  });
});

describe("module-resolver", () => {
  test("resolves simple module name", async () => {
    const elmJson = (await findElmJsonFor(path.join(SMALL_PROJECT, "src", "Main.elm")))!;
    const result = await resolveModuleToFile("Helpers", elmJson);
    expect(result).toBe(path.join(SMALL_PROJECT, "src", "Helpers.elm"));
  });

  test("resolves nested module name", async () => {
    const elmJson = (await findElmJsonFor(path.join(SMALL_PROJECT, "src", "Main.elm")))!;
    const result = await resolveModuleToFile("Nested.Deep.Module", elmJson);
    expect(result).toBe(path.join(SMALL_PROJECT, "src", "Nested", "Deep", "Module.elm"));
  });

  test("returns undefined for nonexistent module", async () => {
    const elmJson = (await findElmJsonFor(path.join(SMALL_PROJECT, "src", "Main.elm")))!;
    const result = await resolveModuleToFile("DoesNot.Exist", elmJson);
    expect(result).toBeUndefined();
  });
});

describe("uri helpers", () => {
  test("uriToPath strips file://", () => {
    expect(uriToPath("file:///tmp/foo.elm")).toBe("/tmp/foo.elm");
  });

  test("pathToUri adds file://", () => {
    expect(pathToUri("/tmp/foo.elm")).toBe("file:///tmp/foo.elm");
  });

  test("round-trips with spaces", () => {
    const original = "/tmp/my project/src/Foo.elm";
    expect(uriToPath(pathToUri(original))).toBe(original);
  });
});

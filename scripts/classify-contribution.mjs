import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const registryPath = path => path === "registry" || path.startsWith("registry/");

export function parseNameStatus(output) {
  const paths = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [status, ...names] = line.split("\t");
    if (!status || !names.length) throw Error(`Invalid git name-status record: ${line}`);
    if (/^[RC]/.test(status)) {
      if (names.length !== 2) throw Error(`Invalid rename/copy record: ${line}`);
      paths.push(...names);
    } else if (names.length === 1) {
      paths.push(names[0]);
    } else {
      throw Error(`Invalid git name-status record: ${line}`);
    }
  }
  return [...new Set(paths)].sort();
}

export function classifyPaths(paths) {
  const changedPaths = [...new Set(paths)].sort();
  const registryPaths = changedPaths.filter(registryPath);
  const corePaths = changedPaths.filter(path => !registryPath(path));
  // A change that crosses the Registry boundary is Core. This includes a
  // rename, because parseNameStatus retains both its source and destination.
  return {
    funnel: registryPaths.length > 0 && corePaths.length === 0 ? "registry" : "core",
    changedPaths,
    registryPaths,
    corePaths,
  };
}

export function classifyRange(base, head) {
  if (!base || !head) throw Error("Both --base and --head are required");
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames", "--no-ext-diff", base, head],
    { encoding: "utf8" },
  );
  return classifyPaths(parseNameStatus(output));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = classifyRange(argument("--base"), argument("--head"));
  console.log(process.argv.includes("--funnel-only") ? result.funnel : JSON.stringify(result));
}

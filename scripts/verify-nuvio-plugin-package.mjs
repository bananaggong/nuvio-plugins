import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const PACKAGE_FILES = [
  { path: ".codex-plugin/plugin.json", mode: "json" },
  { path: ".app.json", mode: "json" },
  { path: "assets/icon.png", mode: "binary" },
  { path: "assets/logo.png", mode: "binary" },
  { path: "README.md", mode: "text" },
  { path: "skills/nuvio-host-center-operations/SKILL.md", mode: "text" },
];

const options = parseArgs(process.argv.slice(2));
const packageRoot = resolve(options.package ?? "plugins/nuvio-host-center");
const manifestPath = resolve(options.manifest ?? "release/nuvio-host-center.json");
const marketplacePath = resolve(options.marketplace ?? ".agents/plugins/marketplace.json");
const snapshot = inspectPackage(packageRoot, marketplacePath);

if (options.writeManifest) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(snapshot.releaseManifest, null, 2)}\n`, "utf8");
}

if (!existsSync(manifestPath)) {
  fail(`Release manifest is missing: ${manifestPath}`);
}

const expected = readJson(manifestPath);
assertReleaseManifest(expected, snapshot.releaseManifest, manifestPath);

if (options.compare) {
  const comparisonRoot = resolve(options.compare);
  const comparisonMarketplace = resolve(options.compareMarketplace ?? comparisonRoot, options.compareMarketplace ? "" : "../../.agents/plugins/marketplace.json");
  const comparison = inspectPackage(comparisonRoot, comparisonMarketplace);
  comparePackages(snapshot, comparison);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({
    packageRoot,
    manifestPath,
    version: snapshot.version,
    sourceHash: snapshot.releaseManifest.sourceHash,
    comparedPackage: options.compare ? resolve(options.compare) : null,
    status: "ok",
  })}\n`);
} else {
  console.log(`NUVIO plugin package verified: ${snapshot.version}`);
  console.log(`source hash: ${snapshot.releaseManifest.sourceHash}`);
  if (options.compare) console.log(`cross-repository package match: ${resolve(options.compare)}`);
}

function inspectPackage(root, marketplace) {
  assertExactPackageFiles(root);
  const normalizedFiles = new Map();
  const fileEntries = {};

  for (const descriptor of PACKAGE_FILES) {
    const absolutePath = resolve(root, descriptor.path);
    if (!existsSync(absolutePath)) fail(`Required plugin file is missing: ${absolutePath}`);
    const rawBuffer = readFileSync(absolutePath);
    const raw = descriptor.mode === "binary" ? null : rawBuffer.toString("utf8");
    if (raw !== null) assertNoSecrets(descriptor.path, raw);
    const normalized = descriptor.mode === "binary"
      ? rawBuffer.toString("base64")
      : descriptor.mode === "json"
        ? `${stableStringify(parseJson(raw, absolutePath))}\n`
        : normalizeText(raw);
    normalizedFiles.set(descriptor.path, normalized);
    fileEntries[descriptor.path] = {
      mode: descriptor.mode,
      sha256: sha256(descriptor.mode === "binary" ? rawBuffer : normalized),
    };
  }

  const plugin = parseJson(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"), "plugin.json");
  const app = parseJson(readFileSync(resolve(root, ".app.json"), "utf8"), ".app.json");
  assertPluginShape(plugin, app, root);
  if (!existsSync(marketplace)) fail(`Marketplace file is missing: ${marketplace}`);
  const marketplaceValue = parseJson(readFileSync(marketplace, "utf8"), marketplace);
  assertMarketplaceShape(marketplaceValue);
  const normalizedMarketplace = `${stableStringify(marketplaceValue)}\n`;

  const sourceHashInput = PACKAGE_FILES
    .map(({ path }) => `${path}\0${normalizedFiles.get(path)}\0`)
    .join("");

  return {
    root,
    version: plugin.version,
    normalizedFiles,
    releaseManifest: {
      schemaVersion: 1,
      plugin: plugin.name,
      version: plugin.version,
      canonicalSource: "nuvio-web/plugins/nuvio-host-center",
      files: fileEntries,
      marketplace: {
        path: ".agents/plugins/marketplace.json",
        sha256: sha256(normalizedMarketplace),
      },
      sourceHash: sha256(sourceHashInput),
    },
    normalizedMarketplace,
  };
}

function assertExactPackageFiles(root) {
  const expected = new Set(PACKAGE_FILES.map(({ path }) => path));
  const actual = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail(`Plugin package must not contain symlinks: ${current}`);
    if (stat.isFile()) {
      actual.push(relative(root, current).replaceAll("\\", "/"));
      continue;
    }
    if (!stat.isDirectory()) fail(`Unsupported plugin package entry: ${current}`);
    for (const entry of readdirSync(current).sort().reverse()) pending.push(join(current, entry));
  }
  actual.sort();
  const unexpected = actual.filter((path) => !expected.has(path));
  const missing = [...expected].filter((path) => !actual.includes(path));
  if (unexpected.length > 0 || missing.length > 0) {
    fail(`Plugin package file set drifted. Unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
  }
}

function assertPluginShape(plugin, app, root) {
  if (plugin.name !== "nuvio-host-center") fail(`Unexpected plugin name in ${root}`);
  if (typeof plugin.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(plugin.version)) {
    fail(`Plugin version is not strict semver: ${String(plugin.version)}`);
  }
  if (plugin.apps !== "./.app.json" || plugin.skills !== "./skills/") {
    fail("plugin.json must retain ./skills/ and ./.app.json bindings");
  }
  if (plugin.author?.email !== "help@nuvio.kr") fail("plugin author support email is missing");
  if (plugin.interface?.composerIcon !== "./assets/icon.png" || plugin.interface?.logo !== "./assets/logo.png") {
    fail("plugin brand assets must retain the reviewed icon and logo paths");
  }
  for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    if (typeof plugin.interface?.[key] !== "string" || !plugin.interface[key]) fail(`Missing interface.${key}`);
  }
  for (const key of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    if (!plugin.interface[key].startsWith("https://")) fail(`interface.${key} must use HTTPS`);
  }
  if (!Array.isArray(plugin.interface?.defaultPrompt) || plugin.interface.defaultPrompt.length < 1 || plugin.interface.defaultPrompt.length > 3) {
    fail("interface.defaultPrompt must contain one to three prompts");
  }
  if (plugin.interface.defaultPrompt.some((prompt) => typeof prompt !== "string" || [...prompt].length > 128)) {
    fail("Each default prompt must be a string no longer than 128 characters");
  }
  if (!app.apps || typeof app.apps !== "object" || Object.keys(app.apps).length !== 1) {
    fail(".app.json must contain exactly one registered MCP connection mapping");
  }
}

function assertMarketplaceShape(marketplace) {
  if (marketplace.name !== "nuvio" || marketplace.interface?.displayName !== "NUVIO") fail("Unexpected marketplace identity");
  const entry = marketplace.plugins?.find((plugin) => plugin.name === "nuvio-host-center");
  if (!entry) fail("NUVIO Host Center marketplace entry is missing");
  if (entry.source?.source !== "local" || entry.source?.path !== "./plugins/nuvio-host-center") fail("Unexpected marketplace source");
  if (entry.policy?.installation !== "AVAILABLE" || entry.policy?.authentication !== "ON_INSTALL") fail("Unexpected marketplace policy");
  if (entry.category !== "Business and Operations") fail("Unexpected marketplace category");
}

function assertReleaseManifest(expected, actual, path) {
  if (stableStringify(expected) !== stableStringify(actual)) {
    fail(`Release manifest drift detected at ${path}. Regenerate it only from the canonical package after review.`);
  }
}

function comparePackages(primary, comparison) {
  if (primary.version !== comparison.version) fail(`Plugin version mismatch: ${primary.version} != ${comparison.version}`);
  for (const descriptor of PACKAGE_FILES) {
    const left = primary.normalizedFiles.get(descriptor.path);
    const right = comparison.normalizedFiles.get(descriptor.path);
    if (left !== right) {
      const kind = descriptor.mode === "json" ? "JSON semantic" : descriptor.mode === "binary" ? "binary exact" : "normalized exact text";
      fail(`${kind} drift detected for ${descriptor.path}`);
    }
  }
  if (primary.releaseManifest.sourceHash !== comparison.releaseManifest.sourceHash) {
    fail("Plugin source hash mismatch");
  }
  if (primary.normalizedMarketplace !== comparison.normalizedMarketplace) fail("Marketplace JSON semantic drift detected");
}

function assertNoSecrets(path, text) {
  const patterns = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "private key"],
    [/\bsk-[A-Za-z0-9_-]{16,}\b/u, "API key"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u, "JWT"],
    [/\bpostgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/iu, "database credential"],
    [/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\s]{12,}["']/iu, "assigned secret"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) fail(`Potential ${label} found in ${path}`);
  }
}

function normalizeText(value) {
  const withoutBom = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  return `${withoutBom.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n*$/u, "")}\n`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function readJson(path) {
  return parseJson(readFileSync(path, "utf8"), path);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(args) {
  const result = { json: false, writeManifest: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") result.json = true;
    else if (arg === "--write-manifest") result.writeManifest = true;
    else if (["--package", "--manifest", "--marketplace", "--compare", "--compare-marketplace"].includes(arg)) {
      const value = args[index + 1];
      if (!value) fail(`Missing value for ${arg}`);
      result[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else fail(`Unknown argument: ${arg}`);
  }
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

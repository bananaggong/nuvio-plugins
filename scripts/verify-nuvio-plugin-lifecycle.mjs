import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PLUGIN_NAME = "nuvio-host-center";
const MARKETPLACE_NAME = "nuvio";
const OLD_COMMIT = "44706eefadcd0b90e12851aed43b1e4c42d4febb";
const OLD_VERSION_PATTERN = /^1\.1\.0(?:\+|$)/u;
const CURRENT_VERSION_PATTERN = /^1\.1\.2(?:\+|$)/u;
const TEXT_EXTENSIONS = new Set([".json", ".md", ".toml", ".txt", ".yaml", ".yml"]);
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "private key"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/u, "API key"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u, "JWT"],
  [/\bpostgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/iu, "database credential"],
  [/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\s]{12,}["']/iu, "assigned secret"],
];
const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH)(?:$|_)/iu;
const SENSITIVE_ENV_PROVIDER = /(?:^|_)(?:ANTHROPIC|AWS|AZURE|CHATGPT|DATABASE|GCP|GH|GITHUB|GOOGLE|MCP|NPM|NUVIO|OPENAI|POSTGRES|SUPABASE|VERCEL)(?:_|$)/iu;
const SAFE_PARENT_ENV_NAMES = new Set([
  "CI",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "SYSTEMROOT",
  "TERM",
  "WINDIR",
]);

const options = parseArgs(process.argv.slice(2));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPluginRoot = resolve(options.package ?? join(repoRoot, "plugins", PLUGIN_NAME));
const canonicalMarketplace = resolve(options.marketplace ?? join(repoRoot, ".agents", "plugins", "marketplace.json"));
const localPublicRepo = resolve(repoRoot, "..", "nuvio-plugins");
const publicRepo = options.publicRepo
  ?? (existsSync(join(localPublicRepo, ".git")) ? localPublicRepo : "https://github.com/bananaggong/nuvio-plugins.git");
const codexBinary = resolveExecutable(options.codexBin ?? process.env.CODEX_LIFECYCLE_CODEX_BIN ?? "codex");
const gitBinary = resolveExecutable(options.gitBin ?? "git");

const currentManifest = readJson(join(canonicalPluginRoot, ".codex-plugin", "plugin.json"));
const currentVersion = currentManifest.version;
if (!CURRENT_VERSION_PATTERN.test(currentVersion)) {
  fail(`Expected the canonical working-tree plugin to be 1.1.2+, received ${String(currentVersion)}`);
}
assertNoSecretsInTree(canonicalPluginRoot, "canonical package");

const originalProfile = resolve(process.env.USERPROFILE || process.env.HOME || homedir());
const originalCodexHome = resolve(process.env.CODEX_HOME || join(originalProfile, ".codex"));
const globalBefore = snapshotGlobalPluginState(originalProfile, originalCodexHome);
const suiteRoot = mkdtempSync(join(tmpdir(), "nuvio-plugin-lifecycle-"));
const isolation = createIsolation(suiteRoot, originalProfile, originalCodexHome);
let finalResult;
let primaryError;

try {
  finalResult = runLifecycle();
} catch (error) {
  primaryError = error;
} finally {
  const globalAfter = snapshotGlobalPluginState(originalProfile, originalCodexHome);
  try {
    assertDeepEqual(globalAfter, globalBefore, "The real user Codex/plugin state changed during the isolated lifecycle test");
  } catch (error) {
    primaryError ??= error;
  }
  if (!options.keepTemp) rmSync(suiteRoot, { recursive: true, force: true });
}

if (primaryError) fail(primaryError instanceof Error ? primaryError.message : String(primaryError));

if (options.json) {
  process.stdout.write(`${JSON.stringify(finalResult)}\n`);
} else {
  console.log(`NUVIO plugin lifecycle verified: ${finalResult.oldVersion} -> ${finalResult.currentVersion}`);
  console.log(`Codex CLI: ${finalResult.codexVersion}`);
  console.log("isolated old install, working-tree update, fresh-process pickup, remove, and reinstall: ok");
  console.log("stable app mapping, -32603 recovery instruction, secret absence, and global-state guard: ok");
  if (options.keepTemp) console.log(`isolated artifacts retained at: ${suiteRoot}`);
}

function runLifecycle() {
  const codexVersion = runCodex(["--version"], "codex-version").stdout.trim();
  const marketplaceRoot = join(suiteRoot, "marketplace");

  runChild(gitBinary, ["clone", "--quiet", "--no-checkout", publicRepo, marketplaceRoot], "clone-public-marketplace");
  const resolvedOldCommit = runChild(
    gitBinary,
    ["-C", marketplaceRoot, "rev-parse", `${OLD_COMMIT}^{commit}`],
    "resolve-old-commit",
  ).stdout.trim();
  if (resolvedOldCommit !== OLD_COMMIT) fail(`Old marketplace commit mismatch: ${resolvedOldCommit}`);
  runChild(gitBinary, ["-C", marketplaceRoot, "checkout", "--quiet", "--detach", OLD_COMMIT], "checkout-old-marketplace");

  const stagedPluginRoot = join(marketplaceRoot, "plugins", PLUGIN_NAME);
  const oldManifest = readJson(join(stagedPluginRoot, ".codex-plugin", "plugin.json"));
  const oldVersion = oldManifest.version;
  if (!OLD_VERSION_PATTERN.test(oldVersion)) fail(`Expected old plugin 1.1.0+, received ${String(oldVersion)}`);
  const oldApp = readJson(join(stagedPluginRoot, ".app.json"));
  const currentApp = readJson(join(canonicalPluginRoot, ".app.json"));
  assertDeepEqual(currentApp, oldApp, ".app.json changed between 1.1.0 and the canonical working tree");
  assertNoSecretsInTree(stagedPluginRoot, "old package");

  runCodex(["plugin", "marketplace", "add", marketplaceRoot, "--json"], "marketplace-add");
  assertMarketplaceConfigured(runCodex(["plugin", "marketplace", "list", "--json"], "marketplace-list-old").stdout);
  runCodex(["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--json"], "install-old");
  const oldList = runCodex(["plugin", "list", "--available", "--json"], "fresh-list-old").stdout;
  assertPluginList(oldList, oldVersion, true, "old install");
  const oldInstalledRoot = findInstalledPackage(isolation.codexHome, oldVersion);
  assertDeepEqual(readJson(join(oldInstalledRoot, ".app.json")), oldApp, "Installed 1.1.0 .app.json drifted");

  rmSync(stagedPluginRoot, { recursive: true, force: true });
  cpSync(canonicalPluginRoot, stagedPluginRoot, { recursive: true });
  cpSync(canonicalMarketplace, join(marketplaceRoot, ".agents", "plugins", "marketplace.json"));

  const stagedCurrent = readJson(join(stagedPluginRoot, ".codex-plugin", "plugin.json"));
  if (stagedCurrent.version !== currentVersion) fail("Working-tree plugin copy did not preserve the current version");
  runCodex(["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--json"], "reinstall-updated-working-tree");

  const freshCurrentList = runCodex(["plugin", "list", "--available", "--json"], "fresh-list-current").stdout;
  assertPluginList(freshCurrentList, currentVersion, true, "fresh-process current pickup");
  const currentInstalledRoot = findInstalledPackage(isolation.codexHome, currentVersion);
  assertDeepEqual(readJson(join(currentInstalledRoot, ".app.json")), currentApp, "Installed 1.1.2+ .app.json drifted");
  assertRecoveryInstruction(currentInstalledRoot);
  assertNoSecretsInTree(currentInstalledRoot, "installed current package");
  assertNoCredentialPersistence(isolation.codexHome);

  runCodex(["plugin", "remove", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--json"], "remove-current");
  const removedList = runCodex(["plugin", "list", "--available", "--json"], "fresh-list-removed").stdout;
  assertPluginList(removedList, currentVersion, false, "removed plugin");
  if (findInstalledPackages(isolation.codexHome, currentVersion).length !== 0) {
    fail("Plugin remove left the current installed package in the isolated cache");
  }

  runCodex(["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--json"], "reinstall-current");
  const reinstalledList = runCodex(["plugin", "list", "--available", "--json"], "fresh-list-reinstalled").stdout;
  assertPluginList(reinstalledList, currentVersion, true, "reinstalled plugin");
  const reinstalledRoot = findInstalledPackage(isolation.codexHome, currentVersion);
  assertRecoveryInstruction(reinstalledRoot);
  assertDeepEqual(readJson(join(reinstalledRoot, ".app.json")), currentApp, "Reinstalled .app.json drifted");
  assertNoSecretsInTree(isolation.codexHome, "isolated Codex home");
  assertNoCredentialPersistence(isolation.codexHome);

  return {
    status: "ok",
    codexVersion,
    oldCommit: OLD_COMMIT,
    oldVersion,
    currentVersion,
    appMappingStable: true,
    recoveryInstructionPresent: true,
    secretsAbsent: true,
    globalStateUnchanged: true,
    lifecycle: ["install-old", "update-working-tree", "fresh-process-pickup", "remove", "reinstall"],
  };
}

function createIsolation(root, realProfile, realCodexHome) {
  const codexHome = join(root, "codex-home");
  const home = join(root, "home");
  const userProfile = join(root, "user-profile");
  const appData = join(root, "app-data");
  const localAppData = join(root, "local-app-data");
  const processTemp = join(root, "temp");
  const gitConfig = join(root, "git-home", ".gitconfig");
  for (const path of [codexHome, home, userProfile, appData, localAppData, processTemp, dirname(gitConfig)]) {
    mkdirSync(path, { recursive: true });
    assertInside(root, path);
  }
  writeFileSync(gitConfig, "# isolated lifecycle verification\n", "utf8");
  for (const path of [codexHome, home, userProfile]) {
    if (samePath(path, realProfile) || samePath(path, realCodexHome)) fail("Isolation path overlaps the real user profile");
  }

  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || !SAFE_PARENT_ENV_NAMES.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  Object.assign(env, {
    CODEX_HOME: codexHome,
    HOME: home,
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TMP: processTemp,
    TEMP: processTemp,
    TMPDIR: processTemp,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    CI: "1",
    NO_COLOR: "1",
  });
  if (process.platform === "win32") {
    const parsed = /^([A-Za-z]:)(.*)$/u.exec(userProfile);
    if (parsed) {
      env.HOMEDRIVE = parsed[1];
      env.HOMEPATH = parsed[2].replaceAll("/", "\\");
    }
  }
  for (const name of Object.keys(env)) {
    if (isSensitiveEnv(name)) fail(`Sensitive environment variable survived isolation: ${name}`);
  }
  return { root, codexHome, home, userProfile, processTemp, env, invocation: 0 };
}

function runCodex(args, label) {
  return runChild(codexBinary, args, label);
}

function runChild(command, args, label) {
  isolation.invocation += 1;
  const cwd = join(suiteRoot, "process-cwd", `${String(isolation.invocation).padStart(2, "0")}-${safeSegment(label)}`);
  mkdirSync(cwd, { recursive: true });
  assertInside(suiteRoot, cwd);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...isolation.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} exited ${String(result.status)}: ${redactOutput(result.stderr || result.stdout || "no output")}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertMarketplaceConfigured(output) {
  const value = parseJsonOutput(output, "marketplace list");
  if (!containsObject(value, (entry) => entry.name === MARKETPLACE_NAME)) {
    fail("Isolated Codex did not report the NUVIO marketplace after add");
  }
}

function assertPluginList(output, version, expectedInstalled, label) {
  const value = parseJsonOutput(output, label);
  const records = collectObjects(value).filter((entry) => entry.name === PLUGIN_NAME || entry.plugin_name === PLUGIN_NAME);
  const record = records.find((entry) => objectContainsValue(entry, version)) ?? records[0];
  if (!record) fail(`${label} did not include ${PLUGIN_NAME}`);
  if (!objectContainsValue(record, version)) fail(`${label} did not expose version ${version}`);
  const installed = readInstalledFlag(record);
  if (installed === undefined) fail(`${label} did not expose an installed-state field`);
  if (installed !== expectedInstalled) {
    fail(`${label} installed state was ${String(installed)}, expected ${String(expectedInstalled)}`);
  }
}

function readInstalledFlag(record) {
  for (const key of ["installed", "is_installed", "enabled", "is_enabled"]) {
    if (typeof record[key] === "boolean") return record[key];
  }
  if (typeof record.status === "string") {
    if (/^(?:installed|enabled)$/iu.test(record.status)) return true;
    if (/^(?:available|not_installed|uninstalled|disabled)$/iu.test(record.status)) return false;
  }
  return undefined;
}

function findInstalledPackage(codexHome, version) {
  const matches = findInstalledPackages(codexHome, version);
  if (matches.length !== 1) fail(`Expected one installed ${PLUGIN_NAME} ${version} package, found ${matches.length}`);
  return matches[0];
}

function findInstalledPackages(codexHome, version) {
  const matches = [];
  walkFiles(codexHome, (path) => {
    if (basename(path) !== "plugin.json" || basename(dirname(path)) !== ".codex-plugin") return;
    const manifest = readJson(path);
    if (manifest.name === PLUGIN_NAME && manifest.version === version) matches.push(dirname(dirname(path)));
  });
  return matches;
}

function assertRecoveryInstruction(pluginRoot) {
  const skillPath = join(pluginRoot, "skills", "nuvio-host-center-operations", "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  for (const expected of ["-32603 Internal error", "재연결 시작", "https://nuvio.kr/host/settings/ai-connections"]) {
    if (!skill.includes(expected)) fail(`Installed recovery guidance is missing: ${expected}`);
  }
  if (!/do not keep retrying/iu.test(skill)) fail("Installed -32603 guidance does not stop repeated retries");
}

function assertNoCredentialPersistence(codexHome) {
  for (const relativePath of ["auth.json", "credentials.json"]) {
    if (existsSync(join(codexHome, relativePath))) {
      fail(`Plugin lifecycle unexpectedly persisted ${relativePath} in isolated CODEX_HOME`);
    }
  }
}

function snapshotGlobalPluginState(profile, codexHome) {
  return {
    config: fingerprintFile(join(codexHome, "config.toml")),
    authMetadata: fingerprintMetadata(join(codexHome, "auth.json")),
    nuvioCache: fingerprintTree(join(codexHome, "plugins", "cache", MARKETPLACE_NAME)),
    personalMarketplace: fingerprintFile(join(profile, ".agents", "plugins", "marketplace.json")),
  };
}

function fingerprintFile(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile()) return { type: "not-file", size: stat.size, mtimeMs: stat.mtimeMs };
  return { sha256: hashBuffer(readFileSync(path)), size: stat.size };
}

function fingerprintMetadata(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { type: stat.isFile() ? "file" : "other", size: stat.size, mtimeMs: stat.mtimeMs };
}

function fingerprintTree(root) {
  if (!existsSync(root)) return null;
  const entries = [];
  walkFiles(root, (path) => {
    entries.push({ path: normalizeRelative(root, path), sha256: hashBuffer(readFileSync(path)), size: statSync(path).size });
  });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function assertNoSecretsInTree(root, label) {
  walkFiles(root, (path) => {
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return;
    const stat = statSync(path);
    if (stat.size > 2 * 1024 * 1024) return;
    const text = readFileSync(path, "utf8");
    for (const [pattern, kind] of SECRET_PATTERNS) {
      if (pattern.test(text)) fail(`Potential ${kind} found in ${label}: ${normalizeRelative(root, path)}`);
    }
  });
}

function walkFiles(root, visit) {
  if (!existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      visit(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const children = readdirSync(current, { withFileTypes: true })
      .map((entry) => join(current, entry.name))
      .sort((left, right) => right.localeCompare(left));
    pending.push(...children);
  }
}

function parseJsonOutput(output, label) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = Math.min(...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0));
    if (Number.isFinite(firstBrace)) {
      try {
        return JSON.parse(trimmed.slice(firstBrace));
      } catch {
        // Fall through to the redacted error below.
      }
    }
    fail(`Invalid JSON from ${label}: ${redactOutput(trimmed)}`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function collectObjects(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, result);
  } else if (value && typeof value === "object") {
    result.push(value);
    for (const item of Object.values(value)) collectObjects(item, result);
  }
  return result;
}

function containsObject(value, predicate) {
  return collectObjects(value).some(predicate);
}

function objectContainsValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => objectContainsValue(item, expected));
  if (value && typeof value === "object") return Object.values(value).some((item) => objectContainsValue(item, expected));
  return false;
}

function resolveExecutable(candidate) {
  if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const direct = join(directory, candidate);
    if (existsSync(direct)) return direct;
    if (extname(candidate)) continue;
    for (const extension of extensions) {
      const path = `${direct}${extension.toLowerCase()}`;
      if (existsSync(path)) return path;
      const upperPath = `${direct}${extension.toUpperCase()}`;
      if (existsSync(upperPath)) return upperPath;
    }
  }
  fail(`Executable not found without invoking a shell: ${candidate}`);
}

function isSensitiveEnv(name) {
  return SENSITIVE_ENV_NAME.test(name) || SENSITIVE_ENV_PROVIDER.test(name) || [
    "ALL_PROXY",
    "DATABASE_URL",
    "GIT_ASKPASS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "PGPASSWORD",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
  ].includes(name.toUpperCase());
}

function assertInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  fail(`Path escaped isolated suite root: ${candidate}`);
}

function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function normalizeRelative(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function safeSegment(value) {
  return value.replace(/[^a-z0-9_-]+/giu, "-").slice(0, 64);
}

function hashBuffer(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertDeepEqual(actual, expected, message) {
  if (stableStringify(actual) !== stableStringify(expected)) fail(message);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function redactOutput(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s]+/giu, "[REDACTED_DATABASE_URL]")
    .trim()
    .slice(0, 4000);
}

function parseArgs(args) {
  const result = { json: false, keepTemp: false };
  const valueOptions = new Set(["--codex-bin", "--git-bin", "--marketplace", "--package", "--public-repo"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") result.json = true;
    else if (arg === "--keep-temp") result.keepTemp = true;
    else if (valueOptions.has(arg)) {
      const value = args[index + 1];
      if (!value) fail(`Missing value for ${arg}`);
      result[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else fail(`Unknown argument: ${arg}`);
  }
  return result;
}

function fail(message) {
  throw new Error(message);
}

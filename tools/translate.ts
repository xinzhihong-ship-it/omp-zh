#!/usr/bin/env bun
/**
 * One-command dictionary maintenance: scan gaps, translate, review, install,
 * verify, and (optionally) publish.
 *
 *   bun tools/translate.ts              # 全自动：扫描 → 翻译 → 并入 → 验证
 *   bun tools/translate.ts --review     # 停在审阅（只打候选，不写词典）
 *   bun tools/translate.ts --push       # 验证通过后自动 commit + push
 *   bun tools/translate.ts --dry-run    # 只扫描 + 翻译，不写任何文件
 *
 * Steps
 * -----
 *   1. scan     extract display-position English missing from the dictionary
 *   2. translate  batch-translate through an OpenAI-compatible endpoint
 *   3. review   print candidates (audit trail; --review stops here)
 *   4. install  merge candidates into dict-extra.json (structural checks gate)
 *   5. verify   ./omp-zh.sh apply && ./omp-zh.sh test
 *   6. publish  git add/commit/push (only with --push)
 *
 * Endpoint: --endpoint / OMP_ZH_ENDPOINT / the local gateway recorded in
 * ~/.omp/agent/models.yml. Credentials never leave the machine.
 */

import * as path from "node:path";

const WORK = path.resolve(import.meta.dir, "..");
const GAPS_PATH = path.join(WORK, "report-gaps.json");
const CANDIDATES_PATH = path.join(WORK, "dict-candidates.json");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const has = (name: string): boolean => args.includes(name);

// Only forwarded when the caller names a model: auto-translate.ts resolves one
// from ~/.omp/agent/models.yml when `--model` is absent. Passing a hard-coded
// alias here overrode that and turned every batch into a 404 on any machine
// whose gateway serves different model ids.
const MODEL = flag("--model") ?? process.env.OMP_ZH_MODEL;
// Automatic by default: the tool exists to keep the dictionary current without
// babysitting. Structural checks (placeholders, digits, term locks) still gate
// every entry, and dict-candidates.json keeps the full audit trail.
const STOP_FOR_REVIEW = has("--review") || has("-r");
const DO_PUSH = has("--push");
const DRY_RUN = has("--dry-run");

/**
 * Run a subprocess, keeping stdout and stderr apart.
 *
 * They must not be concatenated: `patch.ts probe --keys` writes a JSON
 * document on stdout while its module-load progress (sidecar materialisation,
 * launcher linking) goes to stderr, so a merged stream is unparseable. `out`
 * carries stdout, `err` carries stderr, and `both` is provided for the callers
 * that only want to show a combined log.
 */
const run = async (
	cmd: string[],
	opts: { cwd?: string; inherit?: boolean } = {},
): Promise<{ code: number; out: string; err: string; both: string }> => {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd ?? WORK,
		stdout: opts.inherit ? "inherit" : "pipe",
		stderr: opts.inherit ? "inherit" : "pipe",
		env: process.env,
	});
	let out = "";
	let err = "";
	if (!opts.inherit) {
		[out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
	}
	const code = await proc.exited;
	return { code, out, err, both: out + err };
};

const step = (n: number, text: string): void => console.log(`\n\u001b[1m[${n}/6]\u001b[0m ${text}`);

// ── 1. scan ─────────────────────────────────────────────────────────────────

step(1, "扫描缺口（词典未覆盖的界面英文）");
const scanArgs = ["bun", path.join(WORK, "tools", "extract-gaps.ts"), "--json", GAPS_PATH];
const scan = await run(scanArgs);
if (scan.code !== 0) {
	console.error(scan.both.slice(-2000));
	process.exit(1);
}
const gaps = JSON.parse(await Bun.file(GAPS_PATH).text()) as { entries: { key: string; role: string; count: number; snippet: string }[] };
if (gaps.entries.length === 0) {
	console.log("没有缺口——词典已覆盖当前产物的全部界面字符串。");
	process.exit(0);
}
console.log(`发现 ${gaps.entries.length} 条待翻译字符串`);

// Filter by whether the key can actually be rewritten *before* paying for
// translation. A gap key whose text also sits in a logic/identity position is
// banned wholesale by the patcher (`decideAll`), so a dictionary entry for it
// is inert forever — translating it wastes model calls and leaves dead weight
// in dict-extra.json. Ask the patcher for the real verdicts instead of
// guessing from the shape of the string.
const VERDICTS_PATH = path.join(WORK, "report-verdicts.json");
const keysPath = path.join(WORK, "report-gap-keys.json");
await Bun.write(keysPath, JSON.stringify(gaps.entries.map(e => e.key)));
const verdictRun = await run(["bun", path.join(WORK, "patch.ts"), "probe", "--keys", keysPath]);
if (verdictRun.code !== 0) {
	console.error(verdictRun.both.slice(-2000));
	process.exit(1);
}
// `patch.ts` writes the JSON document on stdout and its progress on stderr,
// so stdout is exactly the payload (pretty-printed, hence multi-line) and can
// be parsed whole.
let translatable: Set<string>;
try {
	const parsed = JSON.parse(verdictRun.out) as { verdicts: { key: string; translatable: boolean }[] };
	translatable = new Set(parsed.verdicts.filter(v => v.translatable).map(v => v.key));
	await Bun.write(VERDICTS_PATH, JSON.stringify(parsed, null, 2));
} catch (e) {
	console.error(`无法解析补丁器的判定结果：${e instanceof Error ? e.message : e}`);
	console.error(verdictRun.out.slice(0, 500));
	console.error(verdictRun.err.slice(-500));
	process.exit(1);
}
const skippedKeys = gaps.entries.filter(e => !translatable.has(e.key));
if (skippedKeys.length > 0) {
	console.log(`其中 ${skippedKeys.length} 条永远无法汉化（同一文本也出现在逻辑/身份位，补丁器整条跳过），已排除：`);
	for (const e of skippedKeys.slice(0, 10)) {
		console.log(`  ✗ ${JSON.stringify(e.key).slice(0, 100)}`);
	}
	if (skippedKeys.length > 10) console.log(`  … 其余 ${skippedKeys.length - 10} 条见 ${VERDICTS_PATH}`);
}
gaps.entries = gaps.entries.filter(e => translatable.has(e.key));
if (gaps.entries.length === 0) {
	console.log("排除后没有可翻译的条目。");
	process.exit(0);
}
console.log(`实际送翻：${gaps.entries.length} 条`);
await Bun.write(GAPS_PATH, JSON.stringify(gaps, null, 2));

// ── 2. translate ────────────────────────────────────────────────────────────

step(2, MODEL ? `自动翻译 + 模型自查（模型：${MODEL}）` : "自动翻译 + 模型自查（模型：自动探测）");
const trArgs = ["bun", path.join(WORK, "tools", "auto-translate.ts"), "--gaps", GAPS_PATH];
// Forward the model only when the caller supplied one; otherwise let
// auto-translate.ts resolve it from the endpoint's own config.
if (MODEL) trArgs.push("--model", MODEL);
if (has("--endpoint")) trArgs.push("--endpoint", flag("--endpoint") as string);
if (has("--no-review")) trArgs.push("--no-review");
const tr = await run(trArgs, { inherit: true });
if (tr.code !== 0) process.exit(tr.code);
if (!(await Bun.file(CANDIDATES_PATH).exists())) {
	console.error("翻译未产出候选文件");
	process.exit(1);
}

const candidates = JSON.parse(await Bun.file(CANDIDATES_PATH).text()) as {
	candidates: { key: string; zh: string; flags: string[] }[];
};
const flagged = candidates.candidates.filter(c => c.flags.length > 0);
const clean = candidates.candidates.filter(c => c.flags.length === 0);
console.log(`\n候选：${candidates.candidates.length} 条（${clean.length} 条通过校验，${flagged.length} 条有标记）`);
if (flagged.length > 0) {
	console.log("\n有标记的条目（不会被自动接受，需手工处理）：");
	for (const c of flagged) console.log(`  ⚠ ${JSON.stringify(c.key)}\n     ${JSON.stringify(c.zh)}  [${c.flags.join("; ")}]`);
}

// ── 3. review ───────────────────────────────────────────────────────────────

if (DRY_RUN) {
	console.log(`\n--dry-run：停在审阅阶段。候选见 ${CANDIDATES_PATH}`);
	process.exit(0);
}
if (clean.length === 0) {
	console.log("没有可自动接受的条目。");
	process.exit(0);
}

step(3, "候选（已由模型复核）");
console.log(`并入 dict-extra.json 的 ${clean.length} 条：`);
for (const c of clean) console.log(`  ${JSON.stringify(c.key)}\n    → ${JSON.stringify(c.zh)}`);
console.log(`\n完整候选（含标记项）见 ${CANDIDATES_PATH}`);

if (STOP_FOR_REVIEW) {
	console.log("(--review：停在审阅阶段，不写入词典)");
	process.exit(0);
}

// ── 4. install ──────────────────────────────────────────────────────────────

step(4, "并入词典 dict-extra.json");
const acc = await run(["bun", path.join(WORK, "tools", "auto-translate.ts"), "--accept"]);
console.log(acc.both.trim());
if (acc.code !== 0) process.exit(acc.code);

// ── 5. verify ───────────────────────────────────────────────────────────────

step(5, "应用补丁并验证");
const apply = await run(["./omp-zh.sh", "apply"]);
if (apply.code !== 0) {
	console.error(apply.both.slice(-3000));
	process.exit(1);
}
const test = await run(["./omp-zh.sh", "test"]);
const summary = test.both.split("\n").filter(l => /helper calls|stray CJK|invariants|not ok|FAIL/.test(l)).join("\n");
console.log(summary);
if (test.code !== 0) {
	console.error("\n验证失败——请检查上方输出。此时不要 push。");
	process.exit(1);
}

// ── 6. publish ──────────────────────────────────────────────────────────────

step(6, "发布");
if (!DO_PUSH) {
	console.log("未指定 --push，跳过。要发布时执行：");
	console.log("  git add dict-extra.json && git commit -m '补译' && git push");
	process.exit(0);
}
const commitMsg = flag("--message") ?? `补译：新增 ${clean.length} 条界面译文`;
for (const cmd of [["git", "add", "dict-extra.json"], ["git", "commit", "-m", commitMsg], ["git", "push"]]) {
	const r = await run(cmd as string[], { inherit: true });
	if (r.code !== 0) {
		console.error(`失败：${(cmd as string[]).join(" ")}`);
		process.exit(1);
	}
}
console.log("已推送。用户端跑一行命令即可拿到新词典。");

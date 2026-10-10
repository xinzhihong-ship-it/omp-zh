#!/usr/bin/env bun
/**
 * 注意：对「已打补丁」的产物运行会大量误报（原文已被替换掉）；体检请
 * 用 pristine 备份：bun tools/anchor-check.ts <backup>/cli.js.orig-pristine。
 * 这里对每个锚点跑与 resolveAnchor 相同的策略链（primary exact → alts
 * exact → primary loose → alts loose），列出所有在当前产物上完全无法
 * 定位的条目，并打印 find 中关键字符串在产物里的真实上下文，方便对照
 * 上游新拼写补 alts。
 *
 * 用法：bun tools/anchor-check.ts [cli.js 路径]
 */
import * as fs from "node:fs";
import { matchLoose } from "./loose-anchor";

interface Spelling { find: string; replace: string }
interface AnchorPatch { name: string; find: string; replace: string; all?: true; loose?: { find: string; replace: string }; alts?: readonly Spelling[] }

const patchSrc = fs.readFileSync(new URL("../patch.ts", import.meta.url), "utf8");

/** 从 patch.ts 源码里截取 ANCHOR_PATCHES 数组字面量文本。 */
const extractArray = (src: string): string => {
	const marker = "const ANCHOR_PATCHES: readonly AnchorPatch[] = ";
	const start = src.indexOf(marker);
	if (start === -1) throw new Error("ANCHOR_PATCHES marker not found");
	const open = src.indexOf("[", start + marker.length);
	// 与 loose-anchor 的 matchingBrace 同逻辑：字符串/反引号感知的括号配平
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			i++;
			for (; i < src.length; i++) {
				if (src[i] === "\\") { i++; continue; }
				if (src[i] === quote) break;
			}
			continue;
		}
		if (c === "[") depth++;
		else if (c === "]") {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	throw new Error("unbalanced ANCHOR_PATCHES array");
};

// patch.ts 无 import.meta.main 守卫，直接 import 会执行入口命令；
// 数组体是纯数据（字符串模板），在补齐 FN 常量后求值是安全的。
const ANCHOR_PATCHES: readonly AnchorPatch[] = new Function(
	"FN", "FN_FRAG", "FN_BLOCK", "FN_VLM", "FN_VR",
	`return ${extractArray(patchSrc)};`,
)("__omp_i18n_t", "__omp_i18n_f", "__omp_i18n_b", "__omp_i18n_vlm", "__omp_i18n_vr");

// 与 omp-zh.sh 相同的兜底顺序：`bun patch.ts path` 打印补丁器自己探测的产物路径。
const probe = Bun.spawnSync(["bun", "run", new URL("../patch.ts", import.meta.url).pathname, "path"], {
	stdout: "pipe", stderr: "ignore",
});
const probed = probe.stdout.toString().trim().split("\n").filter(l => l.trim() !== "").pop();
const cliPath = process.argv[2] ?? process.env.OMP_PKG ?? probed;
if (!cliPath || !fs.existsSync(cliPath)) {
	console.error("无法定位 omp 产物；用法: bun tools/anchor-check.ts [cli.js 路径]");
	process.exit(1);
}
const code = fs.readFileSync(cliPath, "utf8");

const findOccurrences = (haystack: string, needle: string): number[] => {
	const out: number[] = [];
	if (needle.length === 0) return out;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return out;
		out.push(idx);
		from = idx + needle.length;
	}
};

let ok = 0;
const missing: { name: string; find: string }[] = [];
for (const patchEntry of ANCHOR_PATCHES) {
	const spellings: Spelling[] = [{ find: patchEntry.find, replace: patchEntry.replace }, ...(patchEntry.alts ?? [])];
	let hit = false;
	for (const s of spellings) {
		if (findOccurrences(code, s.find).length > 0) { hit = true; break; }
	}
	if (!hit) {
		for (const s of spellings) {
			if (matchLoose(code, s.find).length > 0) { hit = true; break; }
		}
	}
	if (hit) { ok++; continue; }
	missing.push({ name: patchEntry.name, find: patchEntry.find });
}

console.log(`bundle: ${cliPath} (${(code.length / 1e6).toFixed(1)}MB)`);
console.log(`anchors: ${ok}/${ANCHOR_PATCHES.length} resolvable, ${missing.length} missing\n`);
for (const m of missing) {
	console.log(`✗ ${m.name}`);
	console.log(`  find: ${m.find.slice(0, 160)}`);
	// 用 find 里最长的带空格字面量片段在产物中定位上下文，帮助写 alts
	const literals = [...m.find.matchAll(/"([^"]{6,})"/g)].map(x => x[1])
		.concat([...m.find.matchAll(/[A-Za-z][A-Za-z ,.:;/()'"-]{10,}/g)].map(x => x[0]));
	const probe = literals.sort((a, b) => b.length - a.length)[0];
	if (probe) {
		const idx = code.indexOf(probe);
		if (idx !== -1) console.log(`  ctx : …${code.slice(Math.max(0, idx - 120), idx + probe.length + 80).replace(/\n/g, "\\n")}…`);
		else console.log(`  ctx : (probe "${probe.slice(0, 60)}" not in bundle)`);
	}
	console.log();
}

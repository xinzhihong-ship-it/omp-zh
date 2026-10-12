#!/usr/bin/env bun
/**
 * Enumerate StringLiteral nodes whose value spans multiple lines and already
 * have dictionary hits — the candidate set for `findBlocks` once it also
 * accepts plain strings (the upstream tips corpus is a `"..."` literal, not a
 * template, so it was invisible to the block rewriter).
 *
 * Reports the classification of each candidate so a non-display use (an
 * identity key, a comparison operand) is visible before it gets wrapped.
 *
 *   bun tools/scan-multiline-strings.ts [cli.js 路径]
 */
import { parse } from "@babel/parser";
import * as fs from "node:fs";
import * as path from "node:path";

const WORK = path.resolve(import.meta.dir, "..");
const dict: Record<string, string> = {
	...(await Bun.file(path.join(WORK, "dict.json")).json()),
	...(await Bun.file(path.join(WORK, "dict-extra.json")).json()),
};

interface AstNode {
	type: string;
	start?: number | null;
	end?: number | null;
	[key: string]: unknown;
}
const isAstNode = (v: unknown): v is AstNode =>
	typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
const childrenOf = (node: AstNode): AstNode[] => {
	const out: AstNode[] = [];
	for (const k of Object.keys(node)) {
		if (k === "start" || k === "end" || k === "loc" || k === "range" || k === "leadingComments" || k === "trailingComments") continue;
		const v = node[k];
		if (Array.isArray(v)) { for (const c of v) if (isAstNode(c)) out.push(c); }
		else if (isAstNode(v)) out.push(v);
	}
	return out;
};

const target = process.argv[2] ?? (await (async () => {
	const p = Bun.spawnSync(["bun", path.join(WORK, "patch.ts"), "path"], { stdout: "pipe", stderr: "ignore" });
	return p.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "";
})());
if (!target || !fs.existsSync(target)) {
	console.error("usage: bun tools/scan-multiline-strings.ts <cli.js>");
	process.exit(1);
}
const code = await Bun.file(target).text();
const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as AstNode;

const rows: { hits: number; total: number; at: number; via: string; first: string }[] = [];
const keyLabel = (parent: AstNode | undefined): string => {
	if (!parent) return "?";
	const key = parent.key;
	if (!isAstNode(key)) return "?";
	if (key.type === "Identifier" && typeof key.name === "string") return key.name;
	if (key.type === "StringLiteral" && typeof key.value === "string") return key.value;
	return "?";
};

const idLabel = (parent: AstNode | undefined): string => {
	if (!parent) return "?";
	const id = parent.id;
	if (isAstNode(id) && typeof id.name === "string") return id.name;
	return "?";
};

const visit = (node: AstNode, parents: AstNode[]): void => {
	if (node.type === "StringLiteral" && typeof node.value === "string" && node.value.includes("\n")) {
		const lines = node.value.split("\n").map(l => l.trim()).filter(Boolean);
		if (lines.length >= 2 && !node.value.includes("{{")) {
			const hits = lines.filter(l => Object.hasOwn(dict, l)).length;
			if (hits >= 1) {
				const parent = parents[parents.length - 1];
				const grand = parents[parents.length - 2];
				const via = parent?.type === "VariableDeclarator"
					? `var:${idLabel(parent)}`
					: parent?.type === "ObjectProperty"
						? `prop:${keyLabel(parent)}`
						: `${parent?.type ?? "?"}<${grand?.type ?? "-"}>`;
				rows.push({
					hits, total: lines.length, at: node.start ?? -1, via,
					first: node.value.slice(0, 70).replace(/\n/g, "\\n"),
				});
			}
		}
	}
	for (const child of childrenOf(node)) visit(child, [...parents, node]);
};
visit(ast, []);

rows.sort((a, b) => b.hits - a.hits);
console.log(`multiline StringLiteral candidates: ${rows.length}`);
for (const r of rows) console.log(`  ${r.hits}/${r.total} @${r.at} [${r.via}] ${JSON.stringify(r.first)}`);

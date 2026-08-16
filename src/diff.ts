// Shared readable line diff (LCS-based) used by the variant matrix and the
// adaptation review. Pure, no filesystem or network. Same output shape both
// places so the UI can render variant diffs identically.

export interface VariantDifferenceLine {
	kind: "context" | "added" | "removed" | "ellipsis";
	text: string;
}

export interface VariantDifference {
	summary: string;
	lines: VariantDifferenceLine[];
}

type RawDifferenceLine = {
	kind: "context" | "added" | "removed";
	text: string;
};

export function readableDifference(
	canonicalContent: string,
	variantContent: string,
): VariantDifference {
	const canonical = canonicalContent.replaceAll("\r\n", "\n").split("\n");
	const variant = variantContent.replaceAll("\r\n", "\n").split("\n");
	const rows = canonical.length;
	const columns = variant.length;
	const lcs = Array.from({ length: rows + 1 }, () =>
		new Uint32Array(columns + 1),
	);
	for (let left = rows - 1; left >= 0; left -= 1) {
		for (let right = columns - 1; right >= 0; right -= 1) {
			lcs[left][right] =
				canonical[left] === variant[right]
					? lcs[left + 1][right + 1] + 1
					: Math.max(lcs[left + 1][right], lcs[left][right + 1]);
		}
	}

	const raw: RawDifferenceLine[] = [];
	let left = 0;
	let right = 0;
	while (left < rows && right < columns) {
		if (canonical[left] === variant[right]) {
			raw.push({ kind: "context", text: canonical[left] });
			left += 1;
			right += 1;
		} else if (lcs[left + 1][right] >= lcs[left][right + 1]) {
			raw.push({ kind: "removed", text: canonical[left] });
			left += 1;
		} else {
			raw.push({ kind: "added", text: variant[right] });
			right += 1;
		}
	}
	while (left < rows) raw.push({ kind: "removed", text: canonical[left++] });
	while (right < columns) raw.push({ kind: "added", text: variant[right++] });

	const changed = raw
		.map((line, index) => (line.kind === "context" ? -1 : index))
		.filter((index) => index >= 0);
	const visible = new Set<number>();
	for (const index of changed) {
		const first = Math.max(0, index - 2);
		const last = Math.min(raw.length - 1, index + 2);
		for (let context = first; context <= last; context += 1) {
			visible.add(context);
		}
	}
	const lines: VariantDifferenceLine[] = [];
	let previous = -1;
	for (const index of [...visible].sort((a, b) => a - b)) {
		if (previous >= 0 && index > previous + 1) {
			lines.push({
				kind: "ellipsis",
				text: `${index - previous - 1} unchanged lines`,
			});
		}
		lines.push(raw[index]);
		previous = index;
	}
	const added = raw.filter((line) => line.kind === "added").length;
	const removed = raw.filter((line) => line.kind === "removed").length;
	return {
		summary:
			added === 0 && removed === 0
				? "No content difference from canonical"
				: `${added} ${added === 1 ? "line" : "lines"} added · ${removed} ${removed === 1 ? "line" : "lines"} removed`,
		lines,
	};
}

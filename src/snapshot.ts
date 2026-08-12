export interface SnapshotCopy {
	location: string;
	sha: string;
	description?: string;
}

export interface SnapshotInventory {
	generatedAt: string;
	stats: {
		totalSkills: number;
		totalCopies: number;
		drift: number;
		duplicate: number;
		unique: number;
	};
	byName: Record<string, SnapshotCopy[]>;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function statusOf(copies: SnapshotCopy[]): string {
	const shas = new Set(copies.map((copy) => copy.sha));
	if (shas.size > 1) return "DRIFT";
	return copies.length > 1 ? "DUP" : "OK";
}

export function renderSnapshot(inventory: SnapshotInventory): string {
	const rows = Object.entries(inventory.byName)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, copies]) => {
			const description = copies[0]?.description ?? "";
			const harnesses = [...new Set(copies.map((copy) => copy.location))]
				.sort((left, right) => left.localeCompare(right))
				.join(", ");
			const status = statusOf(copies);
			let statusClass = "good";
			if (status === "DRIFT") {
				statusClass = "bad";
			} else if (status === "DUP") {
				statusClass = "warn";
			}
			return `<tr><td><code>${escapeHtml(name)}</code></td><td><span class="${statusClass}">${status}</span></td><td>${escapeHtml(harnesses)}</td><td>${escapeHtml(description)}</td></tr>`;
		})
		.join("");

	const generatedAt = new Date(inventory.generatedAt).toLocaleString("en-CA", {
		dateStyle: "medium",
		timeStyle: "short",
	});

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skill Manager snapshot</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; color: #17202a; background: #f8fafc; }
body { max-width: 1100px; margin: 0 auto; padding: 42px 24px; }
h1 { margin: 0; font-size: clamp(2rem, 6vw, 4rem); letter-spacing: -.05em; }
p { color: #52606d; }
.summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 28px 0; }
.metric { border: 1px solid #d9e1e8; background: white; padding: 14px 18px; border-radius: 10px; min-width: 110px; }
.metric b { display: block; font-size: 1.5rem; }
table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d9e1e8; border-radius: 10px; overflow: hidden; }
th, td { padding: 12px; border-bottom: 1px solid #e8edf2; text-align: left; vertical-align: top; }
th { color: #52606d; font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; }
code { font-family: ui-monospace, monospace; font-weight: 700; }
.good { color: #177245; font-weight: 700; }.warn { color: #9a6700; font-weight: 700; }.bad { color: #bb2525; font-weight: 700; }
@media (prefers-color-scheme: dark) { :root, body { color: #e6edf3; background: #0b0e12; } p, th { color: #aab7c4; } .metric, table { background: #141920; border-color: #293442; } th, td { border-color: #293442; } .good { color: #4ee69a; }.warn { color: #f0c86a; }.bad { color: #ff8b7c; } }
@media (max-width: 650px) { body { padding: 26px 14px; } table { font-size: .88rem; } th, td { padding: 9px; } }
</style>
</head>
<body>
<header><h1>Skill Manager</h1><p>Portable inventory snapshot - generated ${escapeHtml(generatedAt)}</p></header>
<section class="summary"><div class="metric"><b>${inventory.stats.totalSkills}</b> skills</div><div class="metric"><b>${inventory.stats.totalCopies}</b> copies</div><div class="metric"><b>${inventory.stats.drift}</b> drifted</div><div class="metric"><b>${inventory.stats.duplicate}</b> duplicates</div></section>
<table><thead><tr><th>Skill</th><th>Status</th><th>Harnesses</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>
</body>
</html>`;
}

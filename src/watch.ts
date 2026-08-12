// Watch mode: monitor scan locations and trigger a re-scan when skills change.
// Uses fs.watch (recursive where supported), debounced, with graceful fallback
// to a polling interval for locations that refuse watching (EPERM on Windows).

import { readdirSync, watch, type FSWatcher } from "node:fs";
import { SCAN_LOCATIONS } from "./config.ts";

const DEBOUNCE_MS = 2000;
const POLL_MS = 10_000;

export type WatchHandler = () => void;

export interface WatchState {
	start(): void;
	stop(): void;
}

export function startWatcher(onChange: WatchHandler): WatchState {
	const watchers: FSWatcher[] = [];
	const failedRoots = new Set<string>();
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const fire = () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			try {
				onChange();
			} catch {
				// re-scan failures are handled by the caller
			}
		}, DEBOUNCE_MS);
	};

	for (const loc of SCAN_LOCATIONS) {
		try {
			const watcher = watch(loc.root, { recursive: true }, () => fire());
			watcher.on("error", () => {
				failedRoots.add(loc.root);
				watcher.close();
			});
			watchers.push(watcher);
		} catch {
			failedRoots.add(loc.root);
		}
	}

	// Polling fallback for roots that failed to watch.
	if (failedRoots.size > 0) {
		const last = new Map<string, string>();
		pollTimer = setInterval(() => {
			for (const root of failedRoots) {
				try {
					const all = readdirSync(root, { recursive: true }) as string[];
					const entries = all.filter((p) => p.endsWith("SKILL.md"));
					const sig = entries.join("\n");
					if (last.has(root) && last.get(root) !== sig) fire();
					last.set(root, sig);
				} catch {
					// dir may not exist yet
				}
			}
		}, POLL_MS);
	}

	return {
		start() {
			// watchers already started in the constructor; kept for symmetry
		},
		stop() {
			for (const w of watchers) w.close();
			if (pollTimer) clearInterval(pollTimer);
			if (debounceTimer) clearTimeout(debounceTimer);
		},
	};
}

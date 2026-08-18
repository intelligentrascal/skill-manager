import { spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";

/**
 * Shared harness for tests that spawn src/server.ts (or any long-running child).
 *
 * The kill path here is deliberately hardened: a leaked server child keeps its
 * stdout pipe open and the node:test runner never exits, which hung the suite
 * for 10430s. Every stopChild call therefore tracks the PID, kills, then
 * escalates to a tree-kill when the graceful signal does not land, and throws
 * when the process still refuses to die - a leak fails FAST, never silently.
 */

export async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	return await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") reject(new Error("missing test port"));
			else resolve(address.port);
		});
	});
}

/** Reserve a free TCP port by binding and immediately closing a probe server. */
export async function reservePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/**
 * Poll a URL until it responds OK or the child dies. Bounded - never waits
 * longer than 8s, so a server that fails to become ready fails fast.
 */
export async function waitForServer(
	url: string,
	child: ChildProcess,
	logs: () => string,
): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		if (hasExited(child)) {
			throw new Error(`server exited before readiness\n${logs()}`);
		}
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`server did not become ready\n${logs()}`);
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child: ChildProcess, ms: number): Promise<void> {
	return new Promise((resolve) => {
		if (hasExited(child)) return resolve();
		const timer = setTimeout(resolve, ms);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/**
 * Force-kill a process and its whole descendant tree. A leaked grandchild
 * (e.g. a git subprocess spawned by the server) keeps the server's stdout pipe
 * open past the parent's death, which is the exact mechanism of the 10430s
 * suite hang. Windows: taskkill /T /F walks the tree. POSIX: the server is
 * spawned with detached:true so it leads its own process group, which SIGKILL
 * can then take down in one shot.
 */
function killTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// Already gone; nothing left to kill.
	}
}

/**
 * Terminate a spawned child and wait for it to actually die. Escalates from a
 * graceful kill to a tree-kill, then throws if the process is still alive - the
 * test fails instead of leaving a pipe open that hangs the whole suite.
 */
export async function stopChild(child: ChildProcess): Promise<void> {
	if (hasExited(child)) return;
	const pid = child.pid;
	if (pid === undefined) return;
	child.kill();
	await waitExit(child, 2_000);
	if (hasExited(child)) return;
	// Graceful kill did not land. Escalate to a tree-kill so no descendant holds
	// the stdout pipe open, then verify the process actually died. Failing to
	// die is a test failure, not a hang: the leak must fail fast.
	killTree(pid);
	await waitExit(child, 3_000);
	if (hasExited(child)) return;
	throw new Error(
		`server child ${pid} refused to die after kill + tree-kill; leaking process tree`,
	);
}
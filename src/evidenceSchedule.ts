// Monthly schedule: the first Friday of every month at 10:00 local time.
// Pure date math here so the boundary cases are unit-testable; the actual
// timer re-arms itself because setTimeout cannot span more than ~24.8 days.

const HOUR = 10;
const MINUTE = 0;
const FRIDAY = 5; // Date.getDay(): 0 = Sunday .. 5 = Friday

/** First Friday of `year`/`month` (month is 0-based) at 10:00 local time. */
export function firstFridayOfMonth(year: number, month: number): Date {
	const first = new Date(year, month, 1);
	const offset = (FRIDAY - first.getDay() + 7) % 7;
	return new Date(year, month, 1 + offset, HOUR, MINUTE, 0, 0);
}

/** Is `date` the first Friday of its month at (or after) 10:00 local time? */
export function isFirstFriday1000(date: Date): boolean {
	const target = firstFridayOfMonth(date.getFullYear(), date.getMonth());
	return (
		date.getDate() === target.getDate() &&
		date.getHours() >= HOUR &&
		date.getHours() < 24
	);
}

/** The next first-Friday 10:00 local time strictly after `from`. */
export function nextFirstFriday1000(from: Date): Date {
	let candidate = firstFridayOfMonth(from.getFullYear(), from.getMonth());
	if (candidate <= from) {
		candidate = firstFridayOfMonth(from.getFullYear(), from.getMonth() + 1);
	}
	return candidate;
}

/** Milliseconds until the next first-Friday 10:00 local time (>= 0). */
export function msUntilNextFirstFriday1000(from: Date): number {
	return Math.max(0, nextFirstFriday1000(from).getTime() - from.getTime());
}

export interface RegistrySchedule {
	/** ISO timestamp of the next scheduled run (may be re-computed as it fires). */
	nextRunAt: string;
	/** stop() cancels the timer. */
	stop(): void;
}

/**
 * Re-arming scheduler: fires `run` once per first-Friday 10:00 local time.
 * The timer re-arms on a capped interval (1 hour) so it never exceeds the
 * setTimeout ceiling and stays correct across long waits.
 */
export function scheduleRegistryCheck(
	run: () => void | Promise<void>,
): RegistrySchedule {
	const MAX_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let nextRunAt = nextFirstFriday1000(new Date());

	const arm = () => {
		if (stopped) return;
		const delay = Math.min(
			msUntilNextFirstFriday1000(new Date()),
			MAX_INTERVAL_MS,
		);
		nextRunAt = nextFirstFriday1000(new Date());
		timer = setTimeout(() => {
			if (stopped) return;
			if (isFirstFriday1000(new Date())) {
				void run();
			}
			arm();
		}, delay);
	};

	arm();

	return {
		get nextRunAt() {
			return nextRunAt.toISOString();
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}

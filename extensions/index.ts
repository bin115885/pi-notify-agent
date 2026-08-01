import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DEFAULT_MIN_NOTIFY_MS = 3000;
const BREAK_REMINDER_TIMES = new Set(["10:00", "11:00", "12:00", "14:30", "15:30", "16:30", "17:30", "18:30"]);
const BREAK_REMINDER_CHECK_MS = 30_000;
const LINUX_SOUND_FILES = [
	"/usr/share/sounds/freedesktop/stereo/complete.oga",
	"/usr/share/sounds/freedesktop/stereo/message.oga",
	"/usr/share/sounds/freedesktop/stereo/bell.oga",
];

type AgentOutcome = "success" | "error" | "aborted" | "other";
type NotifyKind = "success" | "error";
type SoundPlayback = "external" | "terminal-bell";

const commandExistsCache = new Map<string, boolean>();

function psQuote(value: string): string {
	return value.replace(/'/g, "''");
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function appleScriptQuote(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function runDetached(command: string, args: string[]): void {
	execFile(command, args, { windowsHide: true }, (error) => {
		if (error) console.error(`[pi-notify-agent] ${command}: ${error.message}`);
	});
}

function runCommand(command: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, args, { windowsHide: true }, (error) => {
			if (error) console.error(`[pi-notify-agent] ${command}: ${error.message}`);
			resolve(!error);
		});
	});
}

function commandExists(command: string): boolean {
	const cached = commandExistsCache.get(command);
	if (cached !== undefined) return cached;

	const checker = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(checker, [command], {
		stdio: "ignore",
		windowsHide: true,
	});
	const exists = result.status === 0;
	commandExistsCache.set(command, exists);
	return exists;
}

function hasDesktopSession(): boolean {
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.DBUS_SESSION_BUS_ADDRESS);
}

function canUseWindowsToast(): boolean {
	return process.platform === "win32" || commandExists("powershell.exe");
}

function isMac(): boolean {
	return process.platform === "darwin";
}

function isLinux(): boolean {
	return process.platform === "linux";
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	return `${Math.round(seconds)}s`;
}

export const isBreakReminderTime = (now: Date): boolean => {
	const day = now.getDay();
	const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	return day >= 1 && day <= 5 && BREAK_REMINDER_TIMES.has(time);
};

function firstLine(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = text
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return undefined;
	return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function getProjectLabel(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const cwdName = path.basename(ctx.cwd);
	const sessionName = pi.getSessionName();
	return sessionName ? `${sessionName} (${cwdName})` : cwdName;
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const manager = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const xmlDocument = "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]";
	const template = `<toast duration="long"><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
	const safeTemplate = psQuote(template);

	return [
		`$ErrorActionPreference = 'Stop'`,
		`$appId = Get-StartApps | Where-Object { $_.AppID -like '*\\WindowsPowerShell\\v1.0\\powershell.exe' } | Select-Object -First 1 -ExpandProperty AppID`,
		`if (!$appId) { throw 'Windows PowerShell AppUserModelID not found' }`,
		`${manager} > $null`,
		`${xmlDocument} > $null`,
		`$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()`,
		`$xml.LoadXml('${safeTemplate}')`,
		`$toast = [${type}.ToastNotification]::new($xml)`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)`,
	].join("; ");
}

function notifyKitty(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyOsc777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function sendTerminalNotification(title: string, body: string): void {
	if (process.env.KITTY_WINDOW_ID) {
		notifyKitty(title, body);
		return;
	}
	notifyOsc777(title, body);
}

async function sendDesktopNotification(title: string, body: string): Promise<boolean> {
	if (canUseWindowsToast()) {
		return runCommand("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
	}

	if (isMac() && commandExists("osascript")) {
		return runCommand("osascript", ["-e", `display notification \"${appleScriptQuote(body)}\" with title \"${appleScriptQuote(title)}\"`]);
	}

	if (isLinux() && hasDesktopSession() && commandExists("notify-send")) {
		return runCommand("notify-send", [title, body]);
	}

	return false;
}

function playTerminalBell(): void {
	process.stdout.write("\x07");
}

function requestTerminalAttention(): void {
	playTerminalBell();
}

function playSound(): SoundPlayback {
	if (canUseWindowsToast() && commandExists("rundll32.exe")) {
		runDetached("rundll32.exe", ["user32.dll,MessageBeep"]);
		return "external";
	}

	if (isMac() && commandExists("osascript")) {
		runDetached("osascript", ["-e", "beep"]);
		return "external";
	}

	if (isLinux()) {
		if (commandExists("canberra-gtk-play")) {
			runDetached("canberra-gtk-play", ["-i", "complete"]);
			return "external";
		}

		const soundFile = LINUX_SOUND_FILES.find((file) => existsSync(file));
		if (soundFile && commandExists("paplay")) {
			runDetached("paplay", [soundFile]);
			return "external";
		}
	}

	playTerminalBell();
	return "terminal-bell";
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	return [...messages].reverse().find(isAssistantMessage);
}

function parseBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return fallback;

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "on":
		case "yes":
		case "y":
			return true;
		case "0":
		case "false":
		case "off":
		case "no":
		case "n":
			return false;
		default:
			return fallback;
	}
}

function parseMinMs(value: boolean | string | undefined): number {
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return DEFAULT_MIN_NOTIFY_MS;
}

function resolveOutcome(
	lastAssistant: AssistantMessage | undefined,
	lastProviderErrorStatus: number | null,
): { outcome: AgentOutcome; reason?: string } {
	const stopReason = lastAssistant?.stopReason;

	if (stopReason === "stop") return { outcome: "success" };
	if (stopReason === "aborted") return { outcome: "aborted", reason: stopReason };
	if (stopReason === "error") return { outcome: "error", reason: stopReason };
	if (lastProviderErrorStatus && lastProviderErrorStatus >= 400) {
		return { outcome: "error", reason: `HTTP ${lastProviderErrorStatus}` };
	}
	if (!lastAssistant) {
		return { outcome: "other", reason: "assistant message missing" };
	}
	return { outcome: "other", reason: stopReason ?? "unknown" };
}

async function deliverNotification(
	title: string,
	body: string,
	soundEnabled: boolean,
	attentionEnabled: boolean,
): Promise<void> {
	if (!(await sendDesktopNotification(title, body))) {
		sendTerminalNotification(title, body);
	}

	const soundPlayback = soundEnabled ? playSound() : undefined;
	if (attentionEnabled && soundPlayback !== "terminal-bell") {
		requestTerminalAttention();
	}
}

async function notifyBreak(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await deliverNotification(
		"Pi - 休息提醒",
		`${getProjectLabel(ctx, pi)} • 已连续工作一小时，起来活动一下。`,
		parseBoolean(pi.getFlag("notify-sound"), true),
		parseBoolean(pi.getFlag("notify-attention"), true),
	);
}

async function notifyOutcome(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	durationMs: number,
	kind: NotifyKind,
	soundEnabled: boolean,
	attentionEnabled: boolean,
	reason?: string,
	messagePreview?: string,
): Promise<void> {
	const label = getProjectLabel(ctx, pi);
	const duration = formatDuration(durationMs);
	const title = kind === "success" ? "Pi - Job finished" : "Pi - Agent stopped with error";

	let body = `${label} • ${duration}`;
	if (kind === "error" && reason) body += ` • ${reason}`;
	else if (messagePreview) body += ` • ${messagePreview}`;

	await deliverNotification(title, body, soundEnabled, attentionEnabled);
}

export default function notifyExtension(pi: ExtensionAPI): void {
	pi.registerFlag("notify-min-ms", {
		description: "Minimum agent runtime before sending a notification (milliseconds)",
		type: "string",
		default: String(DEFAULT_MIN_NOTIFY_MS),
	});
	pi.registerFlag("notify-success", {
		description: "Send notifications for successful completions: on/off",
		type: "string",
		default: "on",
	});
	pi.registerFlag("notify-error", {
		description: "Send notifications for errors/stops: on/off",
		type: "string",
		default: "on",
	});
	pi.registerFlag("notify-sound", {
		description: "Play a sound together with notifications: on/off",
		type: "string",
		default: "on",
	});
	pi.registerFlag("notify-attention", {
		description: "Emit BEL so supporting terminals can flash taskbar, tab, dock, or urgency state: on/off",
		type: "string",
		default: "on",
	});

	let agentStartedAt: number | null = null;
	let lastProviderErrorStatus: number | null = null;
	let lastAssistantThisRun: AssistantMessage | undefined;
	let breakReminderTimer: ReturnType<typeof setInterval> | undefined;
	let lastBreakReminderKey: string | undefined;

	const checkBreakReminder = async (ctx: ExtensionContext): Promise<void> => {
		const now = new Date();
		const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
		if (!isBreakReminderTime(now) || key === lastBreakReminderKey) return;
		lastBreakReminderKey = key;
		await notifyBreak(pi, ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (breakReminderTimer) clearInterval(breakReminderTimer);
		await checkBreakReminder(ctx);
		breakReminderTimer = setInterval(() => void checkBreakReminder(ctx), BREAK_REMINDER_CHECK_MS);
	});

	pi.on("session_shutdown", async () => {
		if (breakReminderTimer) clearInterval(breakReminderTimer);
		breakReminderTimer = undefined;
	});

	pi.on("agent_start", async () => {
		agentStartedAt = Date.now();
		lastProviderErrorStatus = null;
		lastAssistantThisRun = undefined;
	});

	pi.on("message_end", async (event) => {
		if (isAssistantMessage(event.message)) {
			lastAssistantThisRun = event.message;
		}
	});

	pi.on("after_provider_response", async (event) => {
		if (event.status >= 400) {
			lastProviderErrorStatus = event.status;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const startedAt = agentStartedAt;
		agentStartedAt = null;

		if (startedAt === null) return;

		const durationMs = Date.now() - startedAt;
		if (durationMs < parseMinMs(pi.getFlag("notify-min-ms"))) return;

		const notifySuccess = parseBoolean(pi.getFlag("notify-success"), true);
		const notifyError = parseBoolean(pi.getFlag("notify-error"), true);
		const soundEnabled = parseBoolean(pi.getFlag("notify-sound"), true);
		const attentionEnabled = parseBoolean(pi.getFlag("notify-attention"), true);

		const lastAssistant = lastAssistantThisRun ?? getLastAssistantMessage(event.messages);
		const preview = firstLine(lastAssistant ? getTextContent(lastAssistant) : undefined);
		const { outcome, reason } = resolveOutcome(lastAssistant, lastProviderErrorStatus);

		if (outcome === "aborted") return;
		if (outcome === "success") {
			if (!notifySuccess) return;
			await notifyOutcome(pi, ctx, durationMs, "success", soundEnabled, attentionEnabled, undefined, preview);
			return;
		}

		if (!notifyError) return;
		await notifyOutcome(pi, ctx, durationMs, "error", soundEnabled, attentionEnabled, reason, preview);
	});

	pi.registerCommand("notify-test", {
		description: "Test notification delivery: /notify-test [success|error]",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			const kind: NotifyKind = mode === "error" ? "error" : "success";
			const soundEnabled = parseBoolean(pi.getFlag("notify-sound"), true);
			const attentionEnabled = parseBoolean(pi.getFlag("notify-attention"), true);
			await notifyOutcome(
				pi,
				ctx,
				4200,
				kind,
				soundEnabled,
				attentionEnabled,
				kind === "error" ? "manual test" : undefined,
				"manual test",
			);
			ctx.ui.notify(`notify-test: ${kind}`, kind === "error" ? "warning" : "info");
		},
	});

	pi.registerCommand("notify-status", {
		description: "Show active notification settings",
		handler: async (_args, ctx) => {
			const minMs = parseMinMs(pi.getFlag("notify-min-ms"));
			const success = parseBoolean(pi.getFlag("notify-success"), true);
			const error = parseBoolean(pi.getFlag("notify-error"), true);
			const sound = parseBoolean(pi.getFlag("notify-sound"), true);
			const attention = parseBoolean(pi.getFlag("notify-attention"), true);
			const lines = [
				`notify-min-ms: ${minMs}`,
				`notify-success: ${success ? "on" : "off"}`,
				`notify-error: ${error ? "on" : "off"}`,
				`notify-sound: ${sound ? "on" : "off"}`,
				`notify-attention: ${attention ? "on" : "off"}`,
				"break-reminder: weekdays 10:00, 11:00, 12:00, 14:30, 15:30, 16:30, 17:30, 18:30",
				"hint: attention uses BEL, so supporting terminals can flash taskbar/dock/tab.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

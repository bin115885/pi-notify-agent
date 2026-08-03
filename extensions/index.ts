import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DEFAULT_MIN_NOTIFY_MS = 3000;
const BREAK_REMINDER_TIMES = new Set(["10:00", "11:00", "12:00", "14:30", "15:30", "16:30", "17:30", "18:30"]);
const BREAK_REMINDER_HOST = "127.0.0.1";
const BREAK_REMINDER_PORT = 54_273;
const BREAK_REMINDER_PROTOCOL = "pi-notify-agent/break-reminder/v1\n";
const BREAK_REMINDER_HANDSHAKE_MS = 1000;
const NOTIFY_LOCAL_STATE_VERSION = 1;
const MAC_BREAK_REMINDER_BUNDLE_ID = "com.bin115885.pi-notify-agent.break-reminder";
const MAC_BREAK_REMINDER_APP_NAME = "Pi Break Reminder.app";
const MAC_BREAK_REMINDER_ICON = "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/Clock.icns";
const LINUX_SOUND_FILES = [
	"/usr/share/sounds/freedesktop/stereo/complete.oga",
	"/usr/share/sounds/freedesktop/stereo/message.oga",
	"/usr/share/sounds/freedesktop/stereo/bell.oga",
];

type AgentOutcome = "success" | "error" | "aborted" | "other";
type NotifyKind = "success" | "error";
type SoundPlayback = "external" | "terminal-bell";
export type BreakReminderRole = "leader" | "follower" | "inactive";
export type NotifyLocalState = {
	version: typeof NOTIFY_LOCAL_STATE_VERSION;
	wechatEnabled: boolean;
	breakWeekendsEnabled: boolean;
};
type WechatConfig = { appId: string; appSecret: string; openId: string; templateId: string };
export type WechatTemplateData = { project: string; status: string; duration: string; time: string; summary: string };
type WechatTokenResponse = { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
type WechatTemplateResponse = { errcode?: number; errmsg?: string; msgid?: number };

const commandExistsCache = new Map<string, boolean>();
let wechatAccessToken: { appId: string; value: string; expiresAt: number } | undefined;

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

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(command, args, { windowsHide: true, env }, (error) => {
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

export const isBreakReminderTime = (now: Date, weekendsEnabled = false): boolean => {
	const day = now.getDay();
	const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	return BREAK_REMINDER_TIMES.has(time) && (weekendsEnabled || (day >= 1 && day <= 5));
};

export const getNextBreakReminderTime = (now: Date, weekendsEnabled = false): Date => {
	for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
		for (const time of BREAK_REMINDER_TIMES) {
			const [hour, minute] = time.split(":").map(Number);
			const candidate = new Date(now);
			candidate.setDate(now.getDate() + dayOffset);
			candidate.setHours(hour, minute, 0, 0);
			if (candidate.getTime() > now.getTime() && isBreakReminderTime(candidate, weekendsEnabled)) return candidate;
		}
	}
	throw new Error("无法计算下一次休息提醒时间");
};

export const startBreakReminderCoordinator = (
	onRoleChange: (role: BreakReminderRole) => void,
	onError: (error: Error) => void,
	port = BREAK_REMINDER_PORT,
): { stop: () => void } => {
	let active = true;
	let server: Server | undefined;
	let follower: Socket | undefined;
	const clients = new Set<Socket>();

	const fail = (error: Error): void => {
		active = false;
		follower?.destroy();
		follower = undefined;
		onRoleChange("inactive");
		onError(error);
	};

	const compete = (): void => {
		if (!active) return;
		const candidate = createServer((socket) => {
			clients.add(socket);
			socket.once("error", () => socket.destroy());
			socket.once("close", () => clients.delete(socket));
			socket.write(BREAK_REMINDER_PROTOCOL);
		});

		candidate.once("error", (error: NodeJS.ErrnoException) => {
			if (!active) return;
			if (error.code !== "EADDRINUSE") {
				fail(error);
				return;
			}

			let response = "";
			let verified = false;
			const socket = createConnection({ host: BREAK_REMINDER_HOST, port });
			follower = socket;
			const handshakeTimer = setTimeout(() => {
				fail(new Error(`休息提醒端口 ${port} 被非 pi-notify-agent 进程占用`));
			}, BREAK_REMINDER_HANDSHAKE_MS);

			socket.setEncoding("utf8");
			socket.on("data", (data) => {
				response += data;
				if (response.length < BREAK_REMINDER_PROTOCOL.length) return;
				clearTimeout(handshakeTimer);
				if (response !== BREAK_REMINDER_PROTOCOL) {
					fail(new Error(`休息提醒端口 ${port} 协议不匹配`));
					return;
				}
				verified = true;
				onRoleChange("follower");
			});
			socket.once("error", () => socket.destroy());
			socket.once("close", () => {
				clearTimeout(handshakeTimer);
				follower = undefined;
				if (!active) return;
				if (verified) onRoleChange("inactive");
				setImmediate(compete);
			});
		});

		candidate.listen(port, BREAK_REMINDER_HOST, () => {
			if (!active) {
				candidate.close();
				return;
			}
			server = candidate;
			onRoleChange("leader");
		});
	};

	compete();
	return {
		stop: () => {
			if (!active) return;
			active = false;
			follower?.destroy();
			follower = undefined;
			server?.close();
			server = undefined;
			for (const client of clients) client.destroy();
			clients.clear();
			onRoleChange("inactive");
		},
	};
};

const requireWechatEnv = (key: string): string => {
	const value = process.env[key]?.trim();
	if (!value) throw new Error(`微信测试号配置缺失：${key}`);
	return value;
};

const getWechatConfig = (): WechatConfig => ({
	appId: requireWechatEnv("WECHAT_APP_ID"),
	appSecret: requireWechatEnv("WECHAT_APP_SECRET"),
	openId: requireWechatEnv("WECHAT_OPEN_ID"),
	templateId: requireWechatEnv("WECHAT_TEMPLATE_ID"),
});

export const hasWechatConfig = (): boolean =>
	["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OPEN_ID", "WECHAT_TEMPLATE_ID"].every((key) => Boolean(process.env[key]?.trim()));

const wechatEnvPath = (): string => path.join(homedir(), ".pi", "agent", "private", "env", "wechat.env");
const legacyBreakWeekendsPath = (): string => path.join(homedir(), ".pi", "agent", "notify-break-weekends");
const notifyLocalStatePath = (): string => path.join(homedir(), ".pi", "agent", "local-state", "pi-notify-agent.json");

const validateNotifyLocalState = (value: unknown, filePath: string): NotifyLocalState => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`本地通知状态无效：${filePath}`);
	const state = value as Partial<NotifyLocalState>;
	if (
		state.version !== NOTIFY_LOCAL_STATE_VERSION ||
		typeof state.wechatEnabled !== "boolean" ||
		typeof state.breakWeekendsEnabled !== "boolean"
	) throw new Error(`本地通知状态无效：${filePath}`);
	return state as NotifyLocalState;
};

export const readNotifyLocalState = (filePath = notifyLocalStatePath()): NotifyLocalState =>
	validateNotifyLocalState(JSON.parse(readFileSync(filePath, "utf8")), filePath);

export const writeNotifyLocalState = (state: NotifyLocalState, filePath = notifyLocalStatePath()): void => {
	const validated = validateNotifyLocalState(state, filePath);
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
	renameSync(tempPath, filePath);
};

export const updateNotifyLocalState = (
	patch: Partial<Pick<NotifyLocalState, "wechatEnabled" | "breakWeekendsEnabled">>,
	filePath = notifyLocalStatePath(),
): NotifyLocalState => {
	const state = { ...readNotifyLocalState(filePath), ...patch };
	writeNotifyLocalState(state, filePath);
	return state;
};

const readLegacyBreakWeekendsEnabled = (fallback: boolean): boolean => {
	const filePath = legacyBreakWeekendsPath();
	if (!existsSync(filePath)) return fallback;
	const value = readFileSync(filePath, "utf8").trim();
	if (value === "on") return true;
	if (value === "off") return false;
	throw new Error(`周末休息提醒配置无效：${filePath}`);
};

const removeLegacyLocalState = (): void => {
	const envPath = wechatEnvPath();
	if (existsSync(envPath)) {
		const current = readFileSync(envPath, "utf8");
		const next = current.replace(/^WECHAT_NOTIFY_ENABLED=.*(?:\r?\n|$)/gm, "");
		if (next !== current) writeFileSync(envPath, next, "utf8");
	}
	rmSync(legacyBreakWeekendsPath(), { force: true });
	delete process.env.WECHAT_NOTIFY_ENABLED;
};

const loadNotifyLocalState = (defaults: Omit<NotifyLocalState, "version">): NotifyLocalState => {
	const filePath = notifyLocalStatePath();
	if (!existsSync(filePath)) writeNotifyLocalState({ version: NOTIFY_LOCAL_STATE_VERSION, ...defaults }, filePath);
	const state = readNotifyLocalState(filePath);
	removeLegacyLocalState();
	return state;
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

const macBreakReminderAppPath = (): string =>
	path.join(homedir(), "Library", "Application Support", "pi-notify-agent", MAC_BREAK_REMINDER_APP_NAME);

export async function ensureMacBreakReminderApp(appPath = macBreakReminderAppPath()): Promise<boolean> {
	if (existsSync(path.join(appPath, "Contents", "Resources", "Clock.icns"))) return true;

	mkdirSync(path.dirname(appPath), { recursive: true });
	const temporaryPath = path.join(path.dirname(appPath), `.Pi Break Reminder.${process.pid}.app`);
	rmSync(temporaryPath, { recursive: true, force: true });

	try {
		if (!(await runCommand("osacompile", [
			"-o",
			temporaryPath,
			"-e",
			'set notificationTitle to system attribute "PI_BREAK_REMINDER_TITLE"',
			"-e",
			'set notificationBody to system attribute "PI_BREAK_REMINDER_BODY"',
			"-e",
			"display notification notificationBody with title notificationTitle",
		]))) return false;
		copyFileSync(MAC_BREAK_REMINDER_ICON, path.join(temporaryPath, "Contents", "Resources", "Clock.icns"));
		if (!(await runCommand("plutil", [
			"-insert",
			"CFBundleIdentifier",
			"-string",
			MAC_BREAK_REMINDER_BUNDLE_ID,
			path.join(temporaryPath, "Contents", "Info.plist"),
		]))) return false;
		if (!(await runCommand("plutil", [
			"-replace",
			"CFBundleIconFile",
			"-string",
			"Clock.icns",
			path.join(temporaryPath, "Contents", "Info.plist"),
		]))) return false;
		if (!(await runCommand("codesign", ["--force", "--sign", "-", temporaryPath]))) return false;
		rmSync(appPath, { recursive: true, force: true });
		renameSync(temporaryPath, appPath);
		return true;
	} finally {
		rmSync(temporaryPath, { recursive: true, force: true });
	}
}

async function sendBreakReminderDesktopNotification(title: string, body: string): Promise<boolean> {
	if (!isMac()) return sendDesktopNotification(title, body);

	const appPath = macBreakReminderAppPath();
	if (!(await ensureMacBreakReminderApp(appPath))) return false;
	return runCommand(path.join(appPath, "Contents", "MacOS", "applet"), [], {
		...process.env,
		PI_BREAK_REMINDER_TITLE: title,
		PI_BREAK_REMINDER_BODY: body,
	});
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
	sendNotification = sendDesktopNotification,
): Promise<void> {
	if (!(await sendNotification(title, body))) {
		sendTerminalNotification(title, body);
	}

	const soundPlayback = soundEnabled ? playSound() : undefined;
	if (attentionEnabled && soundPlayback !== "terminal-bell") {
		requestTerminalAttention();
	}
}

async function getWechatAccessToken(config: WechatConfig, forceRefresh = false): Promise<string> {
	if (!forceRefresh && wechatAccessToken?.appId === config.appId && Date.now() < wechatAccessToken.expiresAt) {
		return wechatAccessToken.value;
	}

	const response = await fetch("https://api.weixin.qq.com/cgi-bin/stable_token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "client_credential",
			appid: config.appId,
			secret: config.appSecret,
			force_refresh: forceRefresh,
		}),
	});
	const result = (await response.json()) as WechatTokenResponse;
	if (!response.ok || !result.access_token || !result.expires_in) {
		throw new Error(`微信 access_token 获取失败：HTTP ${response.status}，errcode ${String(result.errcode)}，${result.errmsg ?? "响应格式无效"}`);
	}

	wechatAccessToken = {
		appId: config.appId,
		value: result.access_token,
		expiresAt: Date.now() + Math.max(result.expires_in - 60, 0) * 1000,
	};
	return wechatAccessToken.value;
}

export async function sendWechatNotification(data: WechatTemplateData): Promise<void> {
	const config = getWechatConfig();
	const payload = {
		touser: config.openId,
		template_id: config.templateId,
		data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { value }])),
	};

	const sendOnce = async (accessToken: string) => {
		const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(accessToken)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		const result = (await response.json()) as WechatTemplateResponse;
		return { response, result };
	};

	let accessToken = await getWechatAccessToken(config);
	let { response, result } = await sendOnce(accessToken);
	if (result.errcode === 40001) {
		wechatAccessToken = undefined;
		accessToken = await getWechatAccessToken(config, true);
		({ response, result } = await sendOnce(accessToken));
	}
	if (!response.ok || result.errcode !== 0) {
		throw new Error(`微信模板消息发送失败：HTTP ${response.status}，errcode ${String(result.errcode)}，${result.errmsg ?? "响应格式无效"}`);
	}
}


async function notifyBreak(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await deliverNotification(
		"Pi - 休息提醒",
		`${getProjectLabel(ctx, pi)} • 已连续工作一小时，起来活动一下。`,
		parseBoolean(pi.getFlag("notify-sound"), true),
		parseBoolean(pi.getFlag("notify-attention"), true),
		sendBreakReminderDesktopNotification,
	);
}

async function notifyOutcome(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	durationMs: number,
	kind: NotifyKind,
	soundEnabled: boolean,
	attentionEnabled: boolean,
	wechatEnabled: boolean,
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
	if (wechatEnabled) {
		await sendWechatNotification({
			project: label,
			status: kind === "success" ? "成功" : "失败",
			duration,
			time: new Date().toLocaleString("zh-CN", { hour12: false }),
			summary: body,
		});
	}
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
	pi.registerFlag("notify-break-weekends", {
		description: "Send scheduled break reminders on weekends: on/off",
		type: "string",
		default: "off",
	});
	pi.registerFlag("notify-wechat", {
		description: "Send agent completion notifications through the official WeChat test account: on/off",
		type: "string",
		default: "off",
	});

	let agentStartedAt: number | null = null;
	let lastProviderErrorStatus: number | null = null;
	let lastAssistantThisRun: AssistantMessage | undefined;
	let breakReminderTimer: ReturnType<typeof setTimeout> | undefined;
	let breakReminderCoordinator: { stop: () => void } | undefined;
	let breakReminderRole: BreakReminderRole = "inactive";
	let lastBreakReminderKey: string | undefined;
	let localState = loadNotifyLocalState({
		breakWeekendsEnabled: readLegacyBreakWeekendsEnabled(parseBoolean(pi.getFlag("notify-break-weekends"), false)),
		wechatEnabled: parseBoolean(process.env.WECHAT_NOTIFY_ENABLED, parseBoolean(pi.getFlag("notify-wechat"), false)),
	});
	const isWechatEnabled = (): boolean => localState.wechatEnabled;

	const checkBreakReminder = async (ctx: ExtensionContext): Promise<void> => {
		const now = new Date();
		const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
		if (!isBreakReminderTime(now, localState.breakWeekendsEnabled) || key === lastBreakReminderKey) return;
		lastBreakReminderKey = key;
		await notifyBreak(pi, ctx);
	};

	const scheduleBreakReminder = (ctx: ExtensionContext): void => {
		if (breakReminderRole !== "leader") return;
		if (breakReminderTimer) clearTimeout(breakReminderTimer);
		const delay = getNextBreakReminderTime(new Date(), localState.breakWeekendsEnabled).getTime() - Date.now();
		breakReminderTimer = setTimeout(() => {
			void checkBreakReminder(ctx)
				.catch((error) => console.error(`[pi-notify-agent] break reminder: ${String(error)}`))
				.finally(() => scheduleBreakReminder(ctx));
		}, delay);
	};

	pi.on("session_start", async (_event, ctx) => {
		breakReminderCoordinator?.stop();
		breakReminderCoordinator = startBreakReminderCoordinator(
			(role) => {
				breakReminderRole = role;
				if (breakReminderTimer) clearTimeout(breakReminderTimer);
				breakReminderTimer = undefined;
				if (role !== "leader") return;
				void checkBreakReminder(ctx)
					.catch((error) => console.error(`[pi-notify-agent] break reminder: ${String(error)}`))
					.finally(() => scheduleBreakReminder(ctx));
			},
			(error) => {
				console.error(`[pi-notify-agent] break reminder coordinator: ${error.message}`);
				ctx.ui.notify(error.message, "error");
			},
		);
	});

	pi.on("session_shutdown", async () => {
		breakReminderCoordinator?.stop();
		breakReminderCoordinator = undefined;
		if (breakReminderTimer) clearTimeout(breakReminderTimer);
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
			await notifyOutcome(pi, ctx, durationMs, "success", soundEnabled, attentionEnabled, isWechatEnabled(), undefined, preview);
			return;
		}

		if (!notifyError) return;
		await notifyOutcome(pi, ctx, durationMs, "error", soundEnabled, attentionEnabled, isWechatEnabled(), reason, preview);
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
				isWechatEnabled(),
				kind === "error" ? "manual test" : undefined,
				"manual test",
			);
			ctx.ui.notify(`notify-test: ${kind}`, kind === "error" ? "warning" : "info");
		},
	});
	pi.registerCommand("notify-break-weekends", {
		description: "Control weekend break reminders: /notify-break-weekends [on|off|status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on" || action === "off") {
				localState = updateNotifyLocalState({ breakWeekendsEnabled: action === "on" });
				if (breakReminderRole === "leader") {
					await checkBreakReminder(ctx);
					scheduleBreakReminder(ctx);
				}
			} else if (action !== "status") {
				ctx.ui.notify("用法：/notify-break-weekends [on|off|status]", "warning");
				return;
			}
			ctx.ui.notify(`notify-break-weekends: ${localState.breakWeekendsEnabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("notify-wechat", {
		description: "Control official WeChat test-account notifications: /notify-wechat [on|off|status|test]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "test") {
				await sendWechatNotification({
					project: getProjectLabel(ctx, pi),
					status: "测试",
					duration: "0s",
					time: new Date().toLocaleString("zh-CN", { hour12: false }),
					summary: "微信官方测试号连接正常",
				});
				ctx.ui.notify("微信测试通知已发送", "info");
				return;
			}
			if (action === "on") {
				getWechatConfig();
				localState = updateNotifyLocalState({ wechatEnabled: true });
			} else if (action === "off") {
				localState = updateNotifyLocalState({ wechatEnabled: false });
			} else if (action !== "status") {
				ctx.ui.notify("用法：/notify-wechat [on|off|status|test]", "warning");
				return;
			}

			ctx.ui.notify(
				`notify-wechat: ${isWechatEnabled() ? "on" : "off"}\nwechat-test-account: ${hasWechatConfig() ? "configured" : "missing"}`,
				"info",
			);
		},
	});

	pi.registerCommand("notify-status", {
		description: "Show active notification settings",
		handler: async (_args, ctx) => {
			localState = readNotifyLocalState();
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
				`notify-break-weekends: ${localState.breakWeekendsEnabled ? "on" : "off"}`,
				`break-reminder-role: ${breakReminderRole}`,
				`notify-wechat: ${isWechatEnabled() ? "on" : "off"}`,
				`wechat-test-account: ${hasWechatConfig() ? "configured" : "missing"}`,
				`local-state: ${notifyLocalStatePath()}`,
				"break-reminder: weekdays 10:00, 11:00, 12:00, 14:30, 15:30, 16:30, 17:30, 18:30",
				"hint: attention uses BEL, so supporting terminals can flash taskbar/dock/tab.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

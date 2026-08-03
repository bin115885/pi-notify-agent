import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	ensureMacBreakReminderApp,
	getNextBreakReminderTime,
	isBreakReminderTime,
	readNotifyLocalState,
	startBreakReminderCoordinator,
	updateNotifyLocalState,
	writeNotifyLocalState,
} from "../extensions/index.ts";

const getAvailablePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("无法分配测试端口"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

test("按开关控制周末休息提醒", () => {
	for (const [hour, minute] of [[10, 0], [11, 0], [12, 0], [14, 30], [15, 30], [16, 30], [17, 30], [18, 30]]) {
		assert.equal(isBreakReminderTime(new Date(2026, 2, 2, hour, minute)), true);
	}
	assert.equal(isBreakReminderTime(new Date(2026, 2, 2, 10, 1)), false);
	assert.equal(isBreakReminderTime(new Date(2026, 2, 7, 10, 0)), false);
	assert.equal(isBreakReminderTime(new Date(2026, 2, 7, 10, 0), true), true);
});

test("计算下一次休息提醒而不轮询", () => {
	assert.deepEqual(getNextBreakReminderTime(new Date(2026, 2, 2, 10, 0, 1)), new Date(2026, 2, 2, 11, 0));
	assert.deepEqual(getNextBreakReminderTime(new Date(2026, 2, 6, 18, 30)), new Date(2026, 2, 9, 10, 0));
	assert.deepEqual(getNextBreakReminderTime(new Date(2026, 2, 6, 18, 30), true), new Date(2026, 2, 7, 10, 0));
});

test("macOS 休息提醒使用独立通知应用", { skip: process.platform !== "darwin" }, async (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-break-reminder-app-"));
	const appPath = path.join(dir, "Pi Break Reminder.app");
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	assert.equal(await ensureMacBreakReminderApp(appPath), true);
	const bundleId = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(appPath, "Contents", "Info.plist")], {
		encoding: "utf8",
	});
	assert.equal(bundleId.status, 0, bundleId.stderr);
	assert.equal(bundleId.stdout.trim(), "com.bin115885.pi-notify-agent.break-reminder");
	assert.equal(spawnSync("codesign", ["--verify", appPath]).status, 0);
});

test("统一持久化本地通知状态", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-notify-state-"));
	const filePath = path.join(dir, "local-state", "pi-notify-agent.json");
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeNotifyLocalState({ version: 1, wechatEnabled: false, breakWeekendsEnabled: true }, filePath);
	assert.deepEqual(readNotifyLocalState(filePath), { version: 1, wechatEnabled: false, breakWeekendsEnabled: true });
	assert.deepEqual(updateNotifyLocalState({ wechatEnabled: true }, filePath), {
		version: 1,
		wechatEnabled: true,
		breakWeekendsEnabled: true,
	});
});

test("多会话只保留一个提醒主会话并在退出后接管", { timeout: 3000 }, async (t) => {
	const port = await getAvailablePort();
	let firstLeader!: () => void;
	const firstLeaderReady = new Promise<void>((resolve) => (firstLeader = resolve));
	const first = startBreakReminderCoordinator((role) => role === "leader" && firstLeader(), (error) => assert.fail(error.message), port);
	t.after(() => first.stop());
	await firstLeaderReady;

	let secondFollower!: () => void;
	let secondLeader!: () => void;
	const secondFollowerReady = new Promise<void>((resolve) => (secondFollower = resolve));
	const secondLeaderReady = new Promise<void>((resolve) => (secondLeader = resolve));
	const second = startBreakReminderCoordinator((role) => {
		if (role === "follower") secondFollower();
		if (role === "leader") secondLeader();
	}, (error) => assert.fail(error.message), port);
	t.after(() => second.stop());
	await secondFollowerReady;

	first.stop();
	await secondLeaderReady;
});

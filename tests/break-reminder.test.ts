import assert from "node:assert/strict";
import test from "node:test";
import { isBreakReminderTime } from "../extensions/index.ts";

test("工作日仅在指定时间提醒休息", () => {
	for (const [hour, minute] of [[10, 0], [11, 0], [12, 0], [14, 30], [15, 30], [16, 30], [17, 30], [18, 30]]) {
		assert.equal(isBreakReminderTime(new Date(2026, 2, 2, hour, minute)), true);
	}
	assert.equal(isBreakReminderTime(new Date(2026, 2, 2, 10, 1)), false);
	assert.equal(isBreakReminderTime(new Date(2026, 2, 7, 10, 0)), false);
});

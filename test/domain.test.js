// 领域层边界测试（纯内存，不碰文件）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../monitor.js";
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code, `expected ${code}`);

function setup(thresholdOverrides = {}, t0 = 1_700_000_000_000) {
  const db = M.emptyDb();
  const loft = M.registerLoft(db, { name: "测试棚", offlineTimeoutMs: 60_000 }, t0);
  const device = M.registerDevice(db, { code: "D1", loftId: loft.id }, t0 + 1);
  const sensor = M.registerSensor(db, { deviceId: device.id, metric: "temperature" }, t0 + 2);
  M.addThreshold(db, {
    loftId: loft.id, metric: "temperature",
    min: 15, max: 30, consecutive: 3, ...thresholdOverrides
  }, t0 + 3);
  return { db, loft, device, sensor, t0 };
}

const rd = (device, sensor, value, ts) => ({ deviceId: device.id, sensorId: sensor.id, value, ts });

test("注册校验：重复棚名/设备码/同设备同指标传感器冲突", () => {
  const { db } = setup();
  throwsCode(() => M.registerLoft(db, { name: "测试棚" }), "loft_exists");
  const loft2 = M.registerLoft(db, { name: "另一棚" });
  throwsCode(() => M.registerDevice(db, { code: "D1", loftId: loft2.id }), "device_exists");
  throwsCode(() => M.registerDevice(db, { code: "D9", loftId: "nope" }), "loft_not_found");
  const dev = db.devices[0];
  throwsCode(() => M.registerSensor(db, { deviceId: dev.id, metric: "temperature" }), "sensor_exists");
  throwsCode(() => M.registerSensor(db, { deviceId: dev.id, metric: "gravity" }), "bad_metric");
  throwsCode(() => M.addThreshold(db, { loftId: loft2.id, metric: "temperature", min: 30, max: 30 }), "bad_range");
});

test("短时抖动（未达连续次数）不告警，恢复后计数清零", () => {
  const { db, device, sensor, t0 } = setup();
  M.ingestBatch(db, { batchId: "b1", readings: [rd(device, sensor, 32, t0 + 1000), rd(device, sensor, 33, t0 + 2000)] }, t0 + 10);
  assert.equal(db.alerts.length, 0);
  assert.equal(db.states[sensor.id].breachStreak, 2);
  // 一次恢复 → 抖动消解
  M.ingestBatch(db, { batchId: "b2", readings: [rd(device, sensor, 25, t0 + 3000)] }, t0 + 11);
  assert.equal(db.states[sensor.id].breachStreak, 0);
  assert.equal(db.states[sensor.id].status, "ok");
  assert.equal(db.alerts.length, 0);
  // 再次越限需要重新累计满 3 次
  M.ingestBatch(db, { batchId: "b3", readings: [rd(device, sensor, 31, t0 + 4000)] }, t0 + 12);
  assert.equal(db.alerts.length, 0);
});

test("连续越限达到阈值才告警；告警中持续越限不重复建告警；恢复后自动结束", () => {
  const { db, device, sensor, t0 } = setup();
  M.ingestBatch(db, { batchId: "b1", readings: [rd(device, sensor, 31, t0 + 1000), rd(device, sensor, 32, t0 + 2000)] }, t0 + 10);
  assert.equal(db.alerts.length, 0);
  M.ingestBatch(db, { batchId: "b2", readings: [rd(device, sensor, 33, t0 + 3000)] }, t0 + 11);
  assert.equal(db.alerts.length, 1);
  assert.equal(db.alerts[0].status, M.ALERT_OPEN);
  // 持续越限
  M.ingestBatch(db, { batchId: "b3", readings: [rd(device, sensor, 40, t0 + 4000)] }, t0 + 12);
  assert.equal(db.alerts.length, 1);
  assert.equal(db.alerts[0].lastValue, 40);
  // 恢复 → 自动结束
  M.ingestBatch(db, { batchId: "b4", readings: [rd(device, sensor, 24, t0 + 5000)] }, t0 + 13);
  assert.equal(db.alerts[0].status, M.ALERT_RECOVERED);
  assert.equal(db.alerts[0].recoveredAt, t0 + 5000);
  assert.equal(db.states[sensor.id].alertId, null);
});

test("乱序读数只入历史，不能覆盖较新状态", () => {
  const { db, device, sensor, t0 } = setup();
  // 批内乱序：同批两条 ts 逆序，按 ts 排序推进
  const r = M.ingestBatch(db, {
    batchId: "b1",
    readings: [rd(device, sensor, 33, t0 + 3000), rd(device, sensor, 31, t0 + 1000), rd(device, sensor, 32, t0 + 2000)]
  }, t0 + 10);
  assert.equal(db.alerts.length, 1, "批内排序后仍应构成连续3次越限");
  assert.equal(db.states[sensor.id].ts, t0 + 3000);
  // 跨批乱序补发：旧读数不推进状态机
  const late = M.ingestBatch(db, { batchId: "b2", readings: [rd(device, sensor, 5, t0 + 1500)] }, t0 + 20);
  assert.equal(late.late, 1);
  assert.equal(db.states[sensor.id].ts, t0 + 3000, "状态时间戳未被旧读数覆盖");
  assert.equal(db.states[sensor.id].value, 33, "状态值未被旧读数覆盖");
  // 但旧读数已进入历史且按 ts 有序
  const tss = db.readings[sensor.id].map(x => x.ts);
  assert.deepEqual(tss, [...tss].sort((a, b) => a - b));
  assert.ok(tss.includes(t0 + 1500));
  // 同传感器同时间戳重复读数（即使值不同）不重复入历史
  M.ingestBatch(db, { batchId: "b3", readings: [rd(device, sensor, 99, t0 + 1500)] }, t0 + 21);
  assert.equal(db.readings[sensor.id].filter(x => x.ts === t0 + 1500).length, 1);
});

test("重复批次幂等：原样回放首次结果，不重复计数", () => {
  const { db, device, sensor, t0 } = setup();
  const first = M.ingestBatch(db, { batchId: "DUP", readings: [rd(device, sensor, 31, t0 + 1000)] }, t0 + 10);
  assert.equal(first.duplicated, false);
  assert.equal(first.ingested, 1);
  // 重复批次即使内容不同也整体回放，绝不入库新内容
  const again = M.ingestBatch(db, {
    batchId: "DUP",
    readings: [rd(device, sensor, 99, t0 + 9999), rd(device, sensor, 98, t0 + 8888)]
  }, t0 + 11);
  assert.equal(again.duplicated, true);
  assert.equal(again.ingested, 1);
  assert.equal(db.readings[sensor.id].length, 1);
});

test("批次内任一记录不合法则整批拒绝", () => {
  const { db, device, sensor, t0 } = setup();
  assert.throws(() => M.ingestBatch(db, {
    batchId: "bad",
    readings: [rd(device, sensor, 31, t0 + 1000), { deviceId: device.id, sensorId: sensor.id, value: "NaN", ts: t0 + 2000 }]
  }, t0 + 10), e => e.code === "bad_value");
  throwsCode(() => M.ingestBatch(db, { batchId: "empty", readings: [] }, t0), "empty_batch");
  throwsCode(() => M.ingestBatch(db, { readings: [rd(device, sensor, 1, t0)] }, t0), "missing_field");
  assert.throws(() => M.ingestBatch(db, {
    batchId: "x",
    readings: [rd(device, sensor, 1, t0), rd(device, sensor, 2, t0)]
  }, t0), e => e.code === "duplicate_in_batch");
});

test("维护期不告警，且维护前的连续越限计数不带入维护后", () => {
  const { db, loft, device, sensor, t0 } = setup();
  M.ingestBatch(db, { batchId: "b1", readings: [rd(device, sensor, 31, t0 + 1000), rd(device, sensor, 32, t0 + 2000)] }, t0 + 10);
  assert.equal(db.states[sensor.id].breachStreak, 2);
  const m = M.startMaintenance(db, { loftId: loft.id, reason: "消毒" }, t0 + 3000);
  assert.ok(M.isUnderMaintenance(db, loft.id, t0 + 3001));
  // 维护期内任意越限都不告警
  M.ingestBatch(db, { batchId: "b2", readings: [rd(device, sensor, 40, t0 + 4000), rd(device, sensor, 41, t0 + 5000), rd(device, sensor, 42, t0 + 6000)] }, t0 + 20);
  assert.equal(db.alerts.length, 0);
  assert.equal(db.states[sensor.id].status, "maintenance");
  assert.equal(db.states[sensor.id].breachStreak, 0);
  // 重复开始维护冲突
  throwsCode(() => M.startMaintenance(db, { loftId: loft.id }), "maintenance_active");
  M.stopMaintenance(db, loft.id, t0 + 7000);
  assert.equal(M.isUnderMaintenance(db, loft.id, t0 + 7001), false);
  // 维护结束后重新累计：仅 2 次越限不告警
  M.ingestBatch(db, { batchId: "b3", readings: [rd(device, sensor, 40, t0 + 8000), rd(device, sensor, 41, t0 + 9000)] }, t0 + 30);
  assert.equal(db.alerts.length, 0);
});

test("阈值按设备级覆盖棚级；时段窗口（含跨午夜）生效", () => {
  const db = M.emptyDb();
  const t0 = 1_700_000_000_000;
  const loft = M.registerLoft(db, { name: "棚" }, t0);
  const d1 = M.registerDevice(db, { code: "D1", loftId: loft.id }, t0);
  const d2 = M.registerDevice(db, { code: "D2", loftId: loft.id }, t0);
  const s1 = M.registerSensor(db, { deviceId: d1.id, metric: "temperature" }, t0);
  const s2 = M.registerSensor(db, { deviceId: d2.id, metric: "temperature" }, t0);
  M.addThreshold(db, { loftId: loft.id, metric: "temperature", min: 15, max: 30, consecutive: 2 }, t0);
  M.addThreshold(db, { loftId: loft.id, deviceId: d1.id, metric: "temperature", min: 10, max: 40, consecutive: 2 }, t0);
  // d1 用设备级阈值：35 对棚级越限但对设备级正常
  M.ingestBatch(db, { batchId: "a", readings: [rd(d1, s1, 35, t0 + 1000), rd(d1, s1, 35, t0 + 2000)] }, t0 + 10);
  M.ingestBatch(db, { batchId: "b", readings: [rd(d2, s2, 35, t0 + 1000), rd(d2, s2, 35, t0 + 2000)] }, t0 + 10);
  assert.equal(db.alerts.length, 1);
  assert.equal(db.alerts[0].deviceId, d2.id);
  // 时段：仅 09:00-17:00 生效
  const db2 = M.emptyDb();
  const l2 = M.registerLoft(db2, { name: "棚2" }, t0);
  const dd = M.registerDevice(db2, { code: "X", loftId: l2.id }, t0);
  const ss = M.registerSensor(db2, { deviceId: dd.id, metric: "temperature" }, t0);
  M.addThreshold(db2, { loftId: l2.id, metric: "temperature", min: 15, max: 30, consecutive: 1, timeStart: "09:00", timeEnd: "17:00" }, t0);
  const noon = new Date(2026, 5, 1, 12, 0).getTime();
  const night = new Date(2026, 5, 1, 20, 0).getTime();
  // 窗口外（20点）不匹配阈值
  assert.equal(M.effectiveThreshold(db2, ss, dd, night), null, "20点在 09-17 窗口外");
  M.ingestBatch(db2, { batchId: "n1", readings: [rd(dd, ss, 99, night)] }, night);
  assert.equal(db2.alerts.length, 0, "时段外不告警");
  assert.equal(db2.states[ss.id].status, "no_threshold");
  // 窗口内（次日12点，时间晚于夜间读数，不是乱序）连续1次即告警
  const noonNext = new Date(2026, 5, 2, 12, 0).getTime();
  M.ingestBatch(db2, { batchId: "n2", readings: [rd(dd, ss, 99, noonNext)] }, noonNext);
  assert.equal(db2.alerts.length, 1, "时段内连续1次即告警");
  // 跨午夜窗口 22:00-06:00
  db2.thresholds[0].timeStart = "22:00";
  db2.thresholds[0].timeEnd = "06:00";
  const at23 = new Date(2026, 5, 3, 23, 0).getTime();
  const at02 = new Date(2026, 5, 4, 2, 0).getTime();
  const at10 = new Date(2026, 5, 4, 10, 0).getTime();
  assert.ok(M.effectiveThreshold(db2, ss, dd, at23), "23点应落在跨午夜窗口");
  assert.ok(M.effectiveThreshold(db2, ss, dd, at02), "凌晨2点应落在跨午夜窗口");
  assert.equal(M.effectiveThreshold(db2, ss, dd, at10), null, "上午10点在窗口外");
});

test("告警生命周期：确认/重复确认/指派/升级/关闭前置与重复处置", () => {
  const { db, device, sensor, t0 } = setup();
  M.ingestBatch(db, { batchId: "b", readings: [31, 32, 33].map((v, i) => rd(device, sensor, v, t0 + i * 1000)) }, t0);
  const aid = db.alerts[0].id;

  // open 前不能关闭
  throwsCode(() => M.closeAlert(db, aid), "not_recovered");
  // 指派
  const a1 = M.assignAlert(db, aid, { assignee: "张三" }, t0 + 10);
  assert.equal(db.alerts[0].assignee, "张三");
  // 重复指派同一人 → 拒绝（并发/重复只成功一次）
  throwsCode(() => M.assignAlert(db, aid, { assignee: "张三" }), "already_assigned");
  // 改派他人允许
  M.assignAlert(db, aid, { assignee: "李四" }, t0 + 11);
  assert.equal(db.alerts[0].assignee, "李四");
  // 确认
  M.acknowledgeAlert(db, aid, { by: "李四" }, t0 + 12);
  assert.equal(db.alerts[0].status, M.ALERT_ACKED);
  // 重复确认 → 只成功一次
  throwsCode(() => M.acknowledgeAlert(db, aid), "alert_not_ackable");
  // 升级
  M.escalateAlert(db, aid, {}, t0 + 13);
  assert.equal(db.alerts[0].escalation, 1);
  // 同级/降级拒绝
  throwsCode(() => M.escalateAlert(db, aid, { level: 1 }), "escalation_not_higher");
  M.escalateAlert(db, aid, { level: 3 }, t0 + 14);
  assert.equal(db.alerts[0].escalation, 3);
  // 恢复后不能再升级/确认/指派
  M.ingestBatch(db, { batchId: "r", readings: [rd(device, sensor, 25, t0 + 9000)] }, t0 + 20);
  assert.equal(db.alerts[0].status, M.ALERT_RECOVERED);
  throwsCode(() => M.escalateAlert(db, aid, { level: 4 }), "alert_not_escalatable");
  throwsCode(() => M.assignAlert(db, aid, { assignee: "王五" }), "alert_not_assignable");
  // 关闭
  M.closeAlert(db, aid, { by: "李四" }, t0 + 30);
  assert.equal(db.alerts[0].status, M.ALERT_CLOSED);
  assert.ok(db.alerts[0].closedAt);
  // 重复关闭
  throwsCode(() => M.closeAlert(db, aid), "already_closed");
  // 处置记录全部留痕
  const kinds = db.actions.filter(x => x.alertId === aid).map(x => x.kind);
  assert.deepEqual(kinds, ["assign", "assign", "acknowledge", "escalate", "escalate", "close"]);
});

test("离线超时自动标记；恢复上报自动上线", () => {
  const { db, device, sensor, t0 } = setup({});
  M.ingestBatch(db, { batchId: "up", readings: [rd(device, sensor, 20, t0 + 1000)] }, t0 + 2000);
  assert.equal(device.online, true);
  // 未超时
  assert.equal(M.sweepOffline(db, t0 + 30_000).length, 0);
  // 超时
  const marked = M.sweepOffline(db, t0 + 90_000);
  assert.equal(marked.length, 1);
  assert.equal(device.online, false);
  assert.ok(device.markedOfflineAt);
  // 重复扫描不重复标记
  assert.equal(M.sweepOffline(db, t0 + 100_000).length, 0);
  // 设备恢复上报 → 自动上线
  M.ingestBatch(db, { batchId: "back", readings: [rd(device, sensor, 21, t0 + 200_000)] }, t0 + 200_001);
  assert.equal(device.online, true);
  assert.equal(device.markedOfflineAt, null);
  const kinds = db.events.map(e => e.type);
  assert.ok(kinds.includes("device_offline"));
  assert.ok(kinds.includes("device_online"));
});

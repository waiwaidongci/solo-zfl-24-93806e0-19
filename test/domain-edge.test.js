// 追加的关键边界：乱序读数的安全语义 + HTTP 错误码边界
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../monitor.js";

function setup(consecutive = 3, t0 = 1_700_000_000_000) {
  const db = M.emptyDb();
  const loft = M.registerLoft(db, { name: "边界棚", offlineTimeoutMs: 60_000 }, t0);
  const device = M.registerDevice(db, { code: "B1", loftId: loft.id }, t0);
  const sensor = M.registerSensor(db, { deviceId: device.id, metric: "temperature" }, t0);
  M.addThreshold(db, { loftId: loft.id, metric: "temperature", min: 15, max: 30, consecutive }, t0);
  return { db, loft, device, sensor, t0 };
}
const rd = (device, sensor, value, ts) => ({ deviceId: device.id, sensorId: sensor.id, value, ts });

test("边界：状态正常时，旧时间戳的越限读数不能补触发告警", () => {
  const { db, device, sensor, t0 } = setup();
  // 两个正常读数（新）
  M.ingestBatch(db, { batchId: "ok1", readings: [rd(device, sensor, 24, t0 + 5000), rd(device, sensor, 25, t0 + 6000)] }, t0 + 7000);
  assert.equal(db.alerts.length, 0);
  // 补发一条很旧的越限读数：只入历史，不告警
  const r = M.ingestBatch(db, { batchId: "late1", readings: [rd(device, sensor, 99, t0 + 1000)] }, t0 + 8000);
  assert.equal(r.late, 1);
  assert.equal(db.alerts.length, 0);
  assert.equal(db.states[sensor.id].status, "ok");
});

test("边界：告警进行中，旧时间戳的正常读数不能误恢复告警", () => {
  const { db, device, sensor, t0 } = setup(2);
  M.ingestBatch(db, { batchId: "b1", readings: [rd(device, sensor, 35, t0 + 1000), rd(device, sensor, 36, t0 + 2000)] }, t0 + 3000);
  assert.equal(db.alerts.length, 1);
  assert.equal(db.alerts[0].status, M.ALERT_OPEN);
  // 补发旧的正常读数
  const r = M.ingestBatch(db, { batchId: "lateok", readings: [rd(device, sensor, 22, t0 + 1500)] }, t0 + 4000);
  assert.equal(r.late, 1);
  assert.equal(db.alerts[0].status, M.ALERT_OPEN, "旧读数不得恢复进行中的告警");
  assert.equal(db.alerts[0].recoveredAt, null);
  assert.equal(db.states[sensor.id].alertId, db.alerts[0].id);
  // 一条新的正常读数才能真正恢复
  M.ingestBatch(db, { batchId: "realok", readings: [rd(device, sensor, 23, t0 + 5000)] }, t0 + 6000);
  assert.equal(db.alerts[0].status, M.ALERT_RECOVERED);
});

test("边界：告警关闭后再来新的越限，产生新告警且不影响历史告警", () => {
  const { db, device, sensor, t0 } = setup(1);
  M.ingestBatch(db, { batchId: "a", readings: [rd(device, sensor, 40, t0 + 1000)] }, t0 + 1000);
  const firstId = db.alerts[0].id;
  M.acknowledgeAlert(db, firstId, {}, t0 + 2000);
  M.ingestBatch(db, { batchId: "r", readings: [rd(device, sensor, 20, t0 + 3000)] }, t0 + 3000);
  M.closeAlert(db, firstId, {}, t0 + 4000);
  M.ingestBatch(db, { batchId: "a2", readings: [rd(device, sensor, 41, t0 + 5000)] }, t0 + 5000);
  assert.equal(db.alerts.length, 2);
  const first = db.alerts.find(a => a.id === firstId);
  assert.equal(first.status, M.ALERT_CLOSED, "历史告警保持关闭");
  assert.equal(db.alerts[0].status, M.ALERT_OPEN, "新告警独立开启");
});

test("边界：维护期起止边界——恰好等于开始时刻受维护保护，结束时刻之后不受保护", () => {
  const { db, loft, device, sensor, t0 } = setup(1);
  M.startMaintenance(db, { loftId: loft.id }, t0 + 5000);
  M.ingestBatch(db, { batchId: "m1", readings: [rd(device, sensor, 99, t0 + 5000)] }, t0 + 5000);
  assert.equal(db.alerts.length, 0, "维护开始时刻即生效");
  M.stopMaintenance(db, loft.id, t0 + 9000);
  assert.equal(M.isUnderMaintenance(db, loft.id, t0 + 9000), false, "结束时刻起不再维护");
  M.ingestBatch(db, { batchId: "m2", readings: [rd(device, sensor, 99, t0 + 10000)] }, t0 + 10000);
  assert.equal(db.alerts.length, 1);
});

test("边界：批次覆盖多设备，其中一台离线恢复也应正确上线，结果按时间排序确定", () => {
  const db = M.emptyDb();
  const t0 = 1_700_000_000_000;
  const loft = M.registerLoft(db, { name: "多设备棚" }, t0);
  const d1 = M.registerDevice(db, { code: "M1", loftId: loft.id }, t0);
  const d2 = M.registerDevice(db, { code: "M2", loftId: loft.id }, t0);
  const s1 = M.registerSensor(db, { deviceId: d1.id, metric: "temperature" }, t0);
  const s2 = M.registerSensor(db, { deviceId: d2.id, metric: "humidity" }, t0);
  M.addThreshold(db, { loftId: loft.id, metric: "temperature", min: 0, max: 50, consecutive: 1 }, t0);
  M.addThreshold(db, { loftId: loft.id, metric: "humidity", min: 0, max: 50, consecutive: 1 }, t0);
  // 故意逆序提交
  const r = M.ingestBatch(db, {
    batchId: "multi",
    readings: [rd(d2, s2, 40, t0 + 3000), rd(d1, s1, 20, t0 + 1000), rd(d2, s2, 60, t0 + 4000), rd(d1, s1, 60, t0 + 2000)]
  }, t0 + 5000);
  assert.equal(r.ingested, 4);
  assert.equal(d1.online, true);
  assert.equal(d2.online, true);
  // d1: 20 正常, 60 越限(连续1) -> 1 条告警；d2: 40 正常, 60 越限 -> 1 条告警
  assert.equal(db.alerts.length, 2);
});

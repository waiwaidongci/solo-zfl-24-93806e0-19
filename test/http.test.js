// HTTP 集成测试：真实起服、真实文件持久化、并发请求、子进程验证重启、旧入口回归。
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const runId = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
process.env.MONITOR_DB = join(tmpdir(), `pigeon-monitor-${runId}.json`);
process.env.PIGEON_DB = join(tmpdir(), `pigeons-${runId}.json`);
process.env.SWEEP_DISABLED = "1";

const { app } = await import("../server.js");
const store = await import("../monitor-store.js");
const M = await import("../monitor.js");

let server, base;
before(async () => {
  await store.resetForTests();
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  for (const f of [process.env.MONITOR_DB, process.env.PIGEON_DB]) rmSync(f, { force: true });
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// 注册一条完整链路：棚(超时1s) + 设备 + 温度传感器 + 阈值(连续3)
async function registerChain({ timeoutMs = 1500, consecutive = 3, min = 15, max = 30 } = {}) {
  const loft = (await call("POST", "/api/monitor/lofts", { name: `棚-${Math.random()}`, offlineTimeoutMs: timeoutMs })).json;
  const device = (await call("POST", "/api/monitor/devices", { code: `DEV-${Math.random()}`, loftId: loft.id })).json;
  const sensor = (await call("POST", "/api/monitor/sensors", { deviceId: device.id, metric: "temperature" })).json;
  (await call("POST", "/api/monitor/thresholds", { loftId: loft.id, metric: "temperature", min, max, consecutive }));
  return { loft, device, sensor };
}
const reading = (device, sensor, value, ts = Date.now()) => ({ deviceId: device.id, sensorId: sensor.id, value, ts });

describe("旧入口回归（档案/血统/成绩）", () => {
  test("旧页面可访问且保留指向监控台的链接", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /赛鸽血统环号登记站/);
    assert.match(html, /href="\/monitor"/);
  });
  test("旧 API：列表、创建、重复冲突、血统、转让、成绩", async () => {
    let r = await call("GET", "/api/pigeons");
    assert.equal(r.status, 200);
    assert.ok(r.json.length >= 3);
    r = await call("POST", "/api/pigeons", { ringNo: "CHN-2026-T1", owner: "测试主", color: "灰", loft: "测试棚" });
    assert.equal(r.status, 201);
    r = await call("POST", "/api/pigeons", { ringNo: "CHN-2026-T1", owner: "测试主", color: "灰", loft: "测试棚" });
    assert.equal(r.status, 409);
    r = await call("GET", "/api/pigeons/CHN-2022-188/relation");
    assert.equal(r.status, 200);
    assert.ok(r.json.children.some(c => c.ringNo === "CHN-2026-001"), "父鸽应能查到子代");
    r = await call("POST", "/api/pigeons/CHN-2026-T1/transfers", { to: "新鸽主" });
    assert.equal(r.status, 200);
    assert.equal(r.json.owner, "新鸽主");
    r = await call("POST", "/api/pigeons/CHN-2026-T1/races", { event: "300公里", distance: 300, rank: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.json.races.at(-1).rank, 7);
  });
});

describe("监控台 HTTP 主流程", () => {
  test("监控台页面可访问", async () => {
    const res = await fetch(base + "/monitor");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /鸽舍环境监控台/);
  });

  test("注册冲突与外键返回明确错误码", async () => {
    const loft = (await call("POST", "/api/monitor/lofts", { name: "唯一棚名X" })).json;
    assert.equal((await call("POST", "/api/monitor/lofts", { name: "唯一棚名X" })).status, 409);
    assert.equal((await call("POST", "/api/monitor/devices", { code: "X1", loftId: "no-such-loft" })).status, 404);
    const d = (await call("POST", "/api/monitor/devices", { code: "X1", loftId: loft.id })).json;
    assert.equal((await call("POST", "/api/monitor/devices", { code: "X1", loftId: loft.id })).status, 409);
    await call("POST", "/api/monitor/sensors", { deviceId: d.id, metric: "temperature" });
    assert.equal((await call("POST", "/api/monitor/sensors", { deviceId: d.id, metric: "temperature" })).status, 409);
    // 传感器不属于该设备
    const other = (await call("POST", "/api/monitor/devices", { code: "X2", loftId: loft.id })).json;
    const sOther = (await call("POST", "/api/monitor/sensors", { deviceId: other.id, metric: "humidity" })).json;
    const bad = await call("POST", "/api/monitor/ingest", { batchId: `m-${Math.random()}`, readings: [{ deviceId: d.id, sensorId: sOther.id, value: 1, ts: Date.now() }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /sensor_device_mismatch/);
  });

  test("重复批次幂等：并发重放与换内容重放都不重复入库", async () => {
    const { device, sensor } = await registerChain();
    const batchId = `B-DUP-${Math.random()}`;
    const payloads = [
      { batchId, readings: [reading(device, sensor, 20, Date.now())] },
      // 重复提交即使携带不同/更多内容，也必须回放首次结果
      { batchId, readings: [reading(device, sensor, 99, Date.now() + 5000), reading(device, sensor, 98, Date.now() + 6000)] }
    ];
    const results = await Promise.all(payloads.map(p => call("POST", "/api/monitor/ingest", p)));
    // 并发再发两次相同批次
    const replay = await Promise.all([1, 2].map(() => call("POST", "/api/monitor/ingest", payloads[0])));
    assert.equal(results[0].status, 200);
    assert.equal(results[0].json.duplicated, false);
    assert.equal(results[1].json.duplicated, true);
    assert.equal(results[1].json.ingested, 1);
    assert.ok(replay.every(r => r.json.duplicated === true && r.json.ingested === 1));
    const hist = await call("GET", `/api/monitor/sensors/${sensor.id}/readings`);
    assert.equal(hist.json.readings.length, 1);
  });

  test("非法批次整体回滚：一条坏数据导致全批不入库", async () => {
    const { device, sensor } = await registerChain();
    const t = Date.now();
    const r = await call("POST", "/api/monitor/ingest", {
      batchId: `B-BAD-${Math.random()}`,
      readings: [reading(device, sensor, 20, t), reading(device, sensor, "不是数字", t + 1000)]
    });
    assert.equal(r.status, 400);
    const hist = await call("GET", `/api/monitor/sensors/${sensor.id}/readings`);
    assert.equal(hist.json.readings.length, 0, "坏批次不得留下任何读数");
    // 同批次号在失败后可重新作为新批次提交（失败未占用批次号）
    const ok = await call("POST", "/api/monitor/ingest", { batchId: `B-BAD-${Math.random()}`, readings: [reading(device, sensor, 21, t + 2000)] });
    assert.equal(ok.status, 200);
  });

  test("乱序读数不覆盖较新状态（late 计数与状态保护）", async () => {
    const { device, sensor } = await registerChain();
    const t = Date.now();
    await call("POST", "/api/monitor/ingest", { batchId: `O1-${Math.random()}`, readings: [reading(device, sensor, 33, t + 3000)] });
    const late = await call("POST", "/api/monitor/ingest", { batchId: `O2-${Math.random()}`, readings: [reading(device, sensor, 5, t + 1000)] });
    assert.equal(late.json.late, 1);
    const hist = await call("GET", `/api/monitor/sensors/${sensor.id}/readings`);
    assert.equal(hist.json.state.value, 33, "最新状态仍为新读数");
    assert.equal(hist.json.state.ts, t + 3000);
    assert.equal(hist.json.readings.length, 2, "旧读数进入历史但不推进状态");
  });

  test("连续越限告警→维护期抑制→恢复自动结束→关闭前置与并发唯一性", async () => {
    const { loft, device, sensor } = await registerChain({ consecutive: 3 });
    const t = Date.now();
    // 2 次越限：抖动不告警
    await call("POST", "/api/monitor/ingest", { batchId: `A1-${Math.random()}`, readings: [reading(device, sensor, 31, t + 1000), reading(device, sensor, 32, t + 2000)] });
    let state = (await call("GET", "/api/monitor/state")).json;
    assert.equal(state.alerts.filter(a => a.deviceId === device.id).length, 0);
    // 第 3 次：告警
    await call("POST", "/api/monitor/ingest", { batchId: `A2-${Math.random()}`, readings: [reading(device, sensor, 33, t + 3000)] });
    state = (await call("GET", "/api/monitor/state")).json;
    const alert = state.alerts.find(a => a.deviceId === device.id && a.status === "open");
    assert.ok(alert, "应出现 open 告警");
    // 维护期对另一设备的连续越限不告警
    await call("POST", "/api/monitor/maintenance/start", { loftId: loft.id, reason: "测试消毒" });
    await call("POST", "/api/monitor/ingest", { batchId: `A3-${Math.random()}`, readings: [reading(device, sensor, 40, t + 4000), reading(device, sensor, 41, t + 5000), reading(device, sensor, 42, t + 6000)] });
    state = (await call("GET", "/api/monitor/state")).json;
    assert.equal(state.alerts.filter(a => a.deviceId === device.id).length, 1, "维护期不新增告警");
    assert.equal((await call("POST", "/api/monitor/maintenance/start", { loftId: loft.id })).status, 409);
    await call("POST", "/api/monitor/maintenance/stop", { loftId: loft.id });

    // 未恢复不可关闭
    let r = await call("POST", `/api/monitor/alerts/${alert.id}/close`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not_recovered/);

    // 并发 10 个确认：恰好 1 个成功
    const acks = await Promise.all(Array.from({ length: 10 }, () => call("POST", `/api/monitor/alerts/${alert.id}/acknowledge`, { by: "并发操作员" })));
    assert.equal(acks.filter(x => x.status === 200).length, 1);
    assert.equal(acks.filter(x => x.status === 409).length, 9);
    // 重复确认留痕仅一次
    state = (await call("GET", "/api/monitor/state")).json;
    const acked = state.alerts.find(a => a.id === alert.id);
    assert.equal(acked.status, "acked");
    assert.equal(acked.actions.filter(a => a.kind === "acknowledge").length, 1);

    // 升级边界：降级/同级拒绝，升级成功
    assert.equal((await call("POST", `/api/monitor/alerts/${alert.id}/escalate`, { level: 1 })).status, 200);
    assert.equal((await call("POST", `/api/monitor/alerts/${alert.id}/escalate`, { level: 1 })).status, 409);
    assert.equal((await call("POST", `/api/monitor/alerts/${alert.id}/escalate`, { level: 5 })).status, 200);
    // 指派：重复同人只成功一次（含并发）
    const assigns = await Promise.all([1, 2, 3].map(() => call("POST", `/api/monitor/alerts/${alert.id}/assign`, { assignee: "王工" })));
    assert.equal(assigns.filter(x => x.status === 200).length, 1);
    // 恢复：读数回到区间
    await call("POST", "/api/monitor/ingest", { batchId: `R1-${Math.random()}`, readings: [reading(device, sensor, 25, t + 9000)] });
    state = (await call("GET", "/api/monitor/state")).json;
    const recovered = state.alerts.find(a => a.id === alert.id);
    assert.equal(recovered.status, "recovered");
    assert.ok(recovered.recoveredAt);
    // recovered 后不可再升级/确认
    assert.equal((await call("POST", `/api/monitor/alerts/${alert.id}/escalate`, { level: 6 })).status, 409);
    // 并发 10 个关闭：恰好 1 个成功，其余 already_closed
    const closes = await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", `/api/monitor/alerts/${alert.id}/close`, { by: `关-${i}` })));
    assert.equal(closes.filter(x => x.status === 200).length, 1);
    assert.equal(closes.filter(x => x.status === 409).length, 9);
    state = (await call("GET", "/api/monitor/state")).json;
    assert.equal(state.alerts.find(a => a.id === alert.id).status, "closed");
  });

  test("告警后恢复→再次越限可产生新告警（生命周期不串台）", async () => {
    const { device, sensor } = await registerChain({ consecutive: 1 });
    const t = Date.now();
    await call("POST", "/api/monitor/ingest", { batchId: `C1-${Math.random()}`, readings: [reading(device, sensor, 40, t + 1000)] });
    await call("POST", "/api/monitor/ingest", { batchId: `C2-${Math.random()}`, readings: [reading(device, sensor, 20, t + 2000)] });
    await call("POST", "/api/monitor/ingest", { batchId: `C3-${Math.random()}`, readings: [reading(device, sensor, 41, t + 3000)] });
    const state = (await call("GET", "/api/monitor/state")).json;
    const mine = state.alerts.filter(a => a.deviceId === device.id);
    assert.equal(mine.length, 2);
    assert.equal(mine[1].status, "recovered");
    assert.equal(mine[0].status, "open");
  });

  test("离线超时：扫描标记离线，恢复上报自动上线", async () => {
    const { device, sensor } = await registerChain({ timeoutMs: 800 });
    await call("POST", "/api/monitor/ingest", { batchId: `ON-${Math.random()}`, readings: [reading(device, sensor, 20)] });
    let state = (await call("GET", "/api/monitor/state")).json;
    assert.equal(state.devices.find(d => d.id === device.id).online, true);
    await new Promise(r => setTimeout(r, 1100));
    const sweep = await call("POST", "/api/monitor/sweep", {});
    assert.ok(sweep.json.markedOffline.includes(device.id));
    state = (await call("GET", "/api/monitor/state")).json;
    assert.equal(state.devices.find(d => d.id === device.id).online, false);
    // 再次扫描幂等
    assert.deepEqual((await call("POST", "/api/monitor/sweep", {})).json.markedOffline, []);
    // 新读数自动上线
    await call("POST", "/api/monitor/ingest", { batchId: `BACK-${Math.random()}`, readings: [reading(device, sensor, 21)] });
    state = (await call("GET", "/api/monitor/state")).json;
    assert.equal(state.devices.find(d => d.id === device.id).online, true);
  });

  test("演示数据一键建棚/设备/双传感器/阈值", async () => {
    const r = await call("POST", "/api/monitor/demo-seed", { suffix: `s${Math.floor(Math.random() * 1e6)}` });
    assert.equal(r.status, 200);
    assert.ok(r.json.sensors.length === 2);
  });

  test("HTTP 边界：错误码与删除语义", async () => {
    const { loft, device, sensor } = await registerChain();
    // 缺字段
    assert.equal((await call("POST", "/api/monitor/lofts", {})).status, 400);
    assert.equal((await call("POST", "/api/monitor/devices", { code: "Y1" })).status, 400);
    // 坏 JSON
    const res = await fetch(base + "/api/monitor/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{不是json" });
    assert.equal(res.status, 400);
    // 读数引用不存在的设备/传感器
    const bad1 = await call("POST", "/api/monitor/ingest", { batchId: `E-${Math.random()}`, readings: [{ deviceId: "nope", sensorId: "nope", value: 1, ts: Date.now() }] });
    assert.equal(bad1.status, 404);
    // 不存在的传感器读数历史
    assert.equal((await call("GET", "/api/monitor/sensors/nope/readings")).status, 404);
    // 不存在的告警做处置
    assert.equal((await call("POST", "/api/monitor/alerts/nope/acknowledge", {})).status, 404);
    assert.equal((await call("POST", "/api/monitor/alerts/nope/close", {})).status, 404);
    // 指派缺 assignee
    const t = Date.now();
    await call("POST", "/api/monitor/ingest", { batchId: `AA-${Math.random()}`, readings: [
      reading(device, sensor, 33, t), reading(device, sensor, 34, t + 1000), reading(device, sensor, 35, t + 2000)
    ] });
    const st = await call("GET", "/api/monitor/state");
    const alert = st.json.alerts.find(a => a.deviceId === device.id && a.status === "open");
    assert.ok(alert);
    assert.equal((await call("POST", `/api/monitor/alerts/${alert.id}/assign`, {})).status, 400);
    // 删除阈值：成功一次，再删 404
    const thresholdId = st.json.thresholds.find(x => x.loftId === loft.id && x.deviceId === null).id;
    assert.equal((await call("DELETE", `/api/monitor/thresholds/${thresholdId}`)).status, 200);
    assert.equal((await call("DELETE", `/api/monitor/thresholds/${thresholdId}`)).status, 404);
    // 未匹配路由
    assert.equal((await call("GET", "/api/monitor/nope")).status, 404);
  });
});

describe("持久化：重启后设备/读数/告警/处置仍可查", () => {
  test("数据落盘后，全新进程读到相同记录", async () => {
    // 使用上面测试已产生的数据：用全新子进程直接读同一个 JSON 文件
    const out = execFileSync(process.execPath, [
      "-e",
      `
        import('${join(here, "..", "monitor-store.js").replace(/\\/g, "\\\\")}').then(async (s) => {
          const db = await s.read();
          console.log(JSON.stringify({
            lofts: db.lofts.length,
            devices: db.devices.length,
            sensors: db.sensors.length,
            thresholds: db.thresholds.length,
            alerts: db.alerts.length,
            actions: db.actions.length,
            batches: Object.keys(db.batches).length,
            readingRows: Object.values(db.readings).reduce((n, l) => n + l.length, 0),
            events: db.events.length,
            maintenance: db.maintenance.length,
            closedActions: db.actions.filter(a => a.kind === 'close').length
          }));
        });
      `
    ], { env: process.env }).toString();
    const fresh = JSON.parse(out);
    assert.ok(fresh.devices >= 3, "重启后设备仍在");
    assert.ok(fresh.sensors >= 3, "重启后传感器仍在");
    assert.ok(fresh.alerts >= 2, "重启后告警仍在");
    assert.ok(fresh.actions >= 4, "重启后处置记录仍在");
    assert.ok(fresh.readingRows >= 5, "重启后读数仍在");
    assert.ok(fresh.batches >= 3, "重启后批次记录仍在");
    assert.ok(fresh.closedActions >= 1, "重启后关闭记录仍在");
  });

  test("写入失败整体回滚：内存与文件均不出现半成品", async () => {
    const before = (await store.read()).lofts.length;
    store.setFailWrites(true);
    await assert.rejects(
      store.mutate(db => M.registerLoft(db, { name: "注定回滚的棚" })),
      /injected_write_failure/
    );
    store.setFailWrites(false);
    const after = (await store.read()).lofts.length;
    assert.equal(after, before, "失败事务不得改变可查状态");
    // 失败后系统仍可正常写入
    const ok = await store.mutate(db => M.registerLoft(db, { name: `回滚后恢复-${Math.random()}` }));
    assert.ok(ok.id);
  });
});

// 环境监控 HTTP 路由：/api/monitor/*
import { mutate, read, startSweeper } from "./monitor-store.js";
import {
  registerLoft, registerDevice, registerSensor, addThreshold,
  startMaintenance, stopMaintenance, ingestBatch, sweepOffline,
  acknowledgeAlert, assignAlert, escalateAlert, closeAlert,
  snapshot, alertView
} from "./monitor.js";

export { startSweeper };

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.status = 400;
    err.code = "bad_json";
    throw err;
  }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

// ---------- 注册 ----------
route("POST", /^\/api\/monitor\/lofts$/, async (req, input) =>
  mutate(db => registerLoft(db, input)));

route("POST", /^\/api\/monitor\/devices$/, async (req, input) =>
  mutate(db => registerDevice(db, input)));

route("POST", /^\/api\/monitor\/sensors$/, async (req, input) =>
  mutate(db => registerSensor(db, input)));

// ---------- 阈值 / 维护期 ----------
route("POST", /^\/api\/monitor\/thresholds$/, async (req, input) =>
  mutate(db => addThreshold(db, input)));

route("DELETE", /^\/api\/monitor\/thresholds\/([^/]+)$/, async (req, input, m) =>
  mutate(db => {
    const idx = db.thresholds.findIndex(t => t.id === decodeURIComponent(m[1]));
    if (idx < 0) { const e = new Error("阈值不存在"); e.status = 404; e.code = "threshold_not_found"; throw e; }
    const [removed] = db.thresholds.splice(idx, 1);
    return removed;
  }));

route("POST", /^\/api\/monitor\/maintenance\/start$/, async (req, input) =>
  mutate(db => startMaintenance(db, input)));

route("POST", /^\/api\/monitor\/maintenance\/stop$/, async (req, input) =>
  mutate(db => stopMaintenance(db, input.loftId)));

// ---------- 批次读数 ----------
route("POST", /^\/api\/monitor\/ingest$/, async (req, input) => {
  const now = Date.now();
  // 浏览器便捷上报：缺省 ts 用服务端时间
  if (Array.isArray(input.readings)) {
    input.readings = input.readings.map(r => ({ ...r, ts: r.ts || now }));
  }
  return mutate(db => ingestBatch(db, input, now));
});

route("GET", /^\/api\/monitor\/sensors\/([^/]+)\/readings$/, async (req, input, m) => {
  const db = await read();
  const sensor = db.sensors.find(s => s.id === decodeURIComponent(m[1]));
  if (!sensor) { const e = new Error("传感器不存在"); e.status = 404; e.code = "sensor_not_found"; throw e; }
  return {
    sensor,
    state: db.states[sensor.id],
    readings: (db.readings[sensor.id] || []).slice(-100)
  };
});

// ---------- 告警处置 ----------
route("POST", /^\/api\/monitor\/alerts\/([^/]+)\/acknowledge$/, async (req, input, m) =>
  mutate(db => {
    const action = acknowledgeAlert(db, decodeURIComponent(m[1]), input);
    return { action, alert: alertView(db, db.alerts.find(a => a.id === decodeURIComponent(m[1]))) };
  }));

route("POST", /^\/api\/monitor\/alerts\/([^/]+)\/assign$/, async (req, input, m) =>
  mutate(db => {
    const action = assignAlert(db, decodeURIComponent(m[1]), input);
    return { action, alert: alertView(db, db.alerts.find(a => a.id === decodeURIComponent(m[1]))) };
  }));

route("POST", /^\/api\/monitor\/alerts\/([^/]+)\/escalate$/, async (req, input, m) =>
  mutate(db => {
    const action = escalateAlert(db, decodeURIComponent(m[1]), input);
    return { action, alert: alertView(db, db.alerts.find(a => a.id === decodeURIComponent(m[1]))) };
  }));

route("POST", /^\/api\/monitor\/alerts\/([^/]+)\/close$/, async (req, input, m) =>
  mutate(db => {
    const action = closeAlert(db, decodeURIComponent(m[1]), input);
    return { action, alert: alertView(db, db.alerts.find(a => a.id === decodeURIComponent(m[1]))) };
  }));

// ---------- 运维 ----------
route("POST", /^\/api\/monitor\/sweep$/, async () =>
  mutate(db => ({ markedOffline: sweepOffline(db, Date.now()).map(d => d.id) })));

route("GET", /^\/api\/monitor\/state$/, async () =>
  mutate(db => snapshot(db, Date.now())));

route("POST", /^\/api\/monitor\/demo-seed$/, async (req, input) => {
  const suffix = String(input.suffix || Date.now().toString(36));
  return mutate(db => {
    const t0 = Date.now();
    const loft = registerLoft(db, { name: `演示棚-${suffix}`, offlineTimeoutMs: 60_000 }, t0);
    const device = registerDevice(db, { code: `DEV-${suffix}`, name: `演示设备-${suffix}`, loftId: loft.id }, t0 + 1);
    const sensors = ["temperature", "humidity"].map(metric =>
      registerSensor(db, { deviceId: device.id, metric }, t0 + 2));
    addThreshold(db, { loftId: loft.id, metric: "temperature", min: 15, max: 30, consecutive: 3 }, t0 + 3);
    addThreshold(db, { loftId: loft.id, metric: "humidity", min: 40, max: 70, consecutive: 2 }, t0 + 4);
    return { loft, device, sensors };
  });
});

export async function monitorApi(req, res, pathname) {
  const match = routes.find(r => r.method === req.method && r.pattern.test(pathname));
  if (!match) return false;
  try {
    const input = req.method === "GET" || req.method === "DELETE" ? null : await parseBody(req);
    const m = pathname.match(match.pattern);
    const data = await match.handler(req, input || {}, m);
    json(res, 200, data);
  } catch (err) {
    json(res, err.status || 500, { error: err.code || err.message || "internal_error", message: err.message || err.code || "内部错误" });
  }
  return true;
}

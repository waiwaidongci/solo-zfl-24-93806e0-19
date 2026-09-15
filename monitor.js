// 环境监控领域层（纯逻辑，无 IO 依赖，便于测试）
// 覆盖：注册、阈值（棚/设备/时段）、维护期、分批读数幂等、乱序保护、
// 连续越限告警、抖动抑制、恢复自动结束、告警处置（确认/指派/升级/关闭）、离线超时标记。

export const METRICS = ["temperature", "humidity", "ammonia"];
export const METRIC_LABELS = { temperature: "温度", humidity: "湿度", ammonia: "氨气(ppm)" };
export const ALERT_OPEN = "open";
export const ALERT_ACKED = "acked";
export const ALERT_RECOVERED = "recovered";
export const ALERT_CLOSED = "closed";

export function nowIso(now) {
  return new Date(now).toISOString();
}

let seq = 0;
export function genId(prefix, now = Date.now()) {
  seq = (seq + 1) % 100000;
  const rand = Math.floor(now / 1000).toString(36);
  return `${prefix}_${rand}${seq.toString(36)}${Math.floor(now % 1000).toString(36).padStart(2, "0")}`;
}

export function emptyDb() {
  return {
    lofts: [],
    devices: [],
    sensors: [],
    readings: {}, // sensorId -> [{ts, value, batchId, at}]
    states: {}, // sensorId -> 最新应用状态 {ts, value, status: ok|breaching, breachStreak, alertId}
    thresholds: [],
    maintenance: [], // {id, loftId, start, end:null 表示进行中, reason, at}
    alerts: [],
    actions: [], // 处置记录
    batches: {}, // batchId -> {deviceId, count, duplicated, at}
    events: [] // 全局时间线（设备上下线、告警生命周期、维护期等）
  };
}

// ---------- 工具 ----------
export function fail(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

function requireFields(input, fields) {
  for (const f of fields) {
    if (input[f] === undefined || input[f] === null || input[f] === "") {
      throw fail(400, "missing_field", `缺少字段: ${f}`);
    }
  }
}

function pushEvent(db, type, detail, at) {
  db.events.unshift({ id: genId("evt", at), ts: at, type, detail });
  if (db.events.length > 2000) db.events.length = 2000;
}

// ---------- 注册 ----------
export function registerLoft(db, input, now = Date.now()) {
  requireFields(input, ["name"]);
  const loft = {
    id: input.id || genId("loft", now),
    name: String(input.name),
    location: input.location ? String(input.location) : "",
    offlineTimeoutMs: Number.isFinite(Number(input.offlineTimeoutMs)) && Number(input.offlineTimeoutMs) > 0
      ? Number(input.offlineTimeoutMs) : 5 * 60 * 1000,
    createdAt: now
  };
  if (db.lofts.some(l => l.id === loft.id || l.name === loft.name)) {
    throw fail(409, "loft_exists", "鸽棚已存在");
  }
  db.lofts.push(loft);
  pushEvent(db, "loft_registered", { loftId: loft.id, name: loft.name }, now);
  return loft;
}

export function registerDevice(db, input, now = Date.now()) {
  requireFields(input, ["code", "loftId"]);
  const loft = db.lofts.find(l => l.id === input.loftId);
  if (!loft) throw fail(404, "loft_not_found", "鸽棚不存在");
  const device = {
    id: input.id || genId("dev", now),
    code: String(input.code),
    name: input.name ? String(input.name) : String(input.code),
    loftId: loft.id,
    online: false,
    lastSeen: null,
    markedOfflineAt: null,
    registeredAt: now
  };
  if (db.devices.some(d => d.id === device.id || d.code === device.code)) {
    throw fail(409, "device_exists", "设备已存在");
  }
  db.devices.push(device);
  pushEvent(db, "device_registered", { deviceId: device.id, code: device.code, loftId: loft.id }, now);
  return device;
}

export function registerSensor(db, input, now = Date.now()) {
  requireFields(input, ["deviceId", "metric"]);
  const metric = String(input.metric);
  if (!METRICS.includes(metric)) throw fail(400, "bad_metric", `未知指标: ${metric}`);
  const device = db.devices.find(d => d.id === input.deviceId);
  if (!device) throw fail(404, "device_not_found", "设备不存在");
  if (db.sensors.some(s => s.deviceId === input.deviceId && s.metric === metric)) {
    throw fail(409, "sensor_exists", "该设备上同指标传感器已存在");
  }
  const sensor = {
    id: input.id || genId("sen", now),
    deviceId: device.id,
    metric,
    label: input.label ? String(input.label) : METRIC_LABELS[metric],
    registeredAt: now
  };
  db.sensors.push(sensor);
  db.readings[sensor.id] = [];
  db.states[sensor.id] = { ts: null, value: null, status: "idle", breachStreak: 0, alertId: null };
  pushEvent(db, "sensor_registered", { sensorId: sensor.id, deviceId: device.id, metric }, now);
  return sensor;
}

// ---------- 阈值（按棚 / 按设备 / 按时段） ----------
export function addThreshold(db, input, now = Date.now()) {
  requireFields(input, ["loftId", "metric", "min", "max"]);
  const loft = db.lofts.find(l => l.id === input.loftId);
  if (!loft) throw fail(404, "loft_not_found", "鸽棚不存在");
  if (!METRICS.includes(input.metric)) throw fail(400, "bad_metric", "未知指标");
  const min = Number(input.min);
  const max = Number(input.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw fail(400, "bad_range", "阈值范围无效，需 min < max");
  }
  const timeStart = input.timeStart === undefined || input.timeStart === null ? "00:00" : String(input.timeStart);
  const timeEnd = input.timeEnd === undefined || input.timeEnd === null ? "24:00" : String(input.timeEnd);
  if (!/^\d{2}:\d{2}$/.test(timeStart) || !/^\d{2}:\d{2}$/.test(timeEnd)) {
    throw fail(400, "bad_window", "时段格式应为 HH:MM");
  }
  const threshold = {
    id: input.id || genId("thr", now),
    loftId: loft.id,
    deviceId: input.deviceId || null, // 设备级阈值；为空表示棚级
    metric: input.metric,
    min,
    max,
    timeStart,
    timeEnd,
    consecutive: Number.isFinite(Number(input.consecutive)) && Number(input.consecutive) >= 1
      ? Math.floor(Number(input.consecutive)) : 3,
    createdAt: now
  };
  if (threshold.deviceId && !db.devices.some(d => d.id === threshold.deviceId)) {
    throw fail(404, "device_not_found", "设备不存在");
  }
  db.thresholds.push(threshold);
  pushEvent(db, "threshold_added", {
    loftId: loft.id, deviceId: threshold.deviceId, metric: threshold.metric,
    min, max, window: `${timeStart}-${timeEnd}`
  }, now);
  return threshold;
}

function toMinutes(hhmm) {
  if (hhmm === "24:00") return 24 * 60;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// 时段是否覆盖某一刻度（本地时区分钟）；支持跨午夜（如 22:00-06:00）
function windowCovers(timeStart, timeEnd, minuteOfDay) {
  const s = toMinutes(timeStart);
  let e = toMinutes(timeEnd);
  if (e === 24 * 60 && timeEnd === "24:00" && s === 0) return true; // 全天
  if (s === e) return true;
  if (s < e) return minuteOfDay >= s && minuteOfDay < e;
  // 跨午夜
  return minuteOfDay >= s || minuteOfDay < e;
}

// 设备级 > 棚级；同级别后添加者优先
export function effectiveThreshold(db, sensor, device, ts) {
  const candidates = db.thresholds
    .filter(t => t.metric === sensor.metric && t.loftId === device.loftId)
    .filter(t => !t.deviceId || t.deviceId === device.id)
    .filter(t => windowCovers(t.timeStart, t.timeEnd, minuteOfLocalDay(ts)));
  const deviceLevel = candidates.filter(t => t.deviceId === device.id);
  const pool = deviceLevel.length ? deviceLevel : candidates.filter(t => !t.deviceId);
  return pool.length ? pool[pool.length - 1] : null;
}

function minuteOfLocalDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

// ---------- 维护期 ----------
export function startMaintenance(db, input, now = Date.now()) {
  requireFields(input, ["loftId"]);
  const loft = db.lofts.find(l => l.id === input.loftId);
  if (!loft) throw fail(404, "loft_not_found", "鸽棚不存在");
  if (isUnderMaintenance(db, loft.id, now)) {
    throw fail(409, "maintenance_active", "该鸽棚已在维护期");
  }
  const m = {
    id: genId("mnt", now),
    loftId: loft.id,
    start: now,
    end: null,
    reason: input.reason ? String(input.reason) : "",
    at: now
  };
  db.maintenance.push(m);
  pushEvent(db, "maintenance_started", { loftId: loft.id, reason: m.reason }, now);
  return m;
}

export function stopMaintenance(db, loftId, now = Date.now()) {
  const m = db.maintenance.find(x => x.loftId === loftId && x.end === null);
  if (!m) throw fail(404, "maintenance_not_found", "没有进行中的维护期");
  m.end = now;
  pushEvent(db, "maintenance_stopped", { loftId, maintenanceId: m.id }, now);
  return m;
}

export function isUnderMaintenance(db, loftId, ts) {
  return db.maintenance.some(m => m.loftId === loftId && m.start <= ts && (m.end === null || m.end > ts));
}

// ---------- 离线超时标记 ----------
// 周期性/惰性扫描：超过棚配置超时未上报即标记 offline，恢复上报时回到 online。
export function sweepOffline(db, now = Date.now()) {
  const changes = [];
  for (const device of db.devices) {
    const loft = db.lofts.find(l => l.id === device.loftId);
    const timeoutMs = loft ? loft.offlineTimeoutMs : 5 * 60 * 1000;
    if (device.lastSeen !== null && device.online && now - device.lastSeen > timeoutMs) {
      device.online = false;
      device.markedOfflineAt = now;
      changes.push(device);
      pushEvent(db, "device_offline", { deviceId: device.id, code: device.code, lastSeen: device.lastSeen }, now);
      // 设备离线：其进行中的告警保持不变（仍需处置），但状态机不再推进
    }
  }
  return changes;
}

// ---------- 读数 ----------
// 校验整批：任一记录不合法则整体拒绝（事务回滚，计数不变）
export function validateBatch(db, input) {
  if (!input || !input.batchId) throw fail(400, "missing_field", "缺少 batchId");
  if (!Array.isArray(input.readings) || input.readings.length === 0) {
    throw fail(400, "empty_batch", "批次读数为空");
  }
  const seen = new Set();
  for (const [i, r] of input.readings.entries()) {
    if (!r || !r.deviceId) throw fail(400, "bad_reading", `第${i + 1}条缺少 deviceId`);
    const device = db.devices.find(d => d.id === r.deviceId);
    if (!device) throw fail(404, "device_not_found", `第${i + 1}条设备不存在: ${r.deviceId}`);
    if (!r.sensorId) throw fail(400, "bad_reading", `第${i + 1}条缺少 sensorId`);
    const sensor = db.sensors.find(s => s.id === r.sensorId);
    if (!sensor) throw fail(404, "sensor_not_found", `第${i + 1}条传感器不存在`);
    if (sensor.deviceId !== device.id) throw fail(400, "sensor_device_mismatch", `第${i + 1}条传感器不属于该设备`);
    const value = Number(r.value);
    if (!Number.isFinite(value)) throw fail(400, "bad_value", `第${i + 1}条数值无效`);
    const ts = Number(r.ts);
    if (!Number.isFinite(ts) || ts <= 0) throw fail(400, "bad_ts", `第${i + 1}条时间戳无效`);
    const key = `${r.sensorId}@${ts}`;
    if (seen.has(key)) throw fail(409, "duplicate_in_batch", `批次内重复读数: ${key}`);
    seen.add(key);
  }
}

// 处理一个传感器的一次已排序读数（ts 严格递增才会推进状态机）
function applyReading(db, sensor, device, ts, value, batchId, at) {
  const list = db.readings[sensor.id];
  // 持久历史去重：同传感器同时间戳视为重复（值不同也拒绝该条，时间戳是读数唯一坐标）
  if (list.some(r => r.ts === ts)) return { stored: false, applied: false, reason: "duplicate" };

  const record = { ts, value, batchId, at };
  // 插入到正确位置以保持历史按 ts 有序
  let pos = list.length;
  while (pos > 0 && list[pos - 1].ts > ts) pos--;
  list.splice(pos, 0, record);
  if (list.length > 2000) list.length = 2000;

  const state = db.states[sensor.id];
  const outOfOrder = state.ts !== null && ts <= state.ts;
  if (outOfOrder) {
    // 乱序读数：只入历史，绝不覆盖较新状态
    return { stored: true, applied: false, reason: "out_of_order" };
  }

  state.ts = ts;
  state.value = value;

  const threshold = effectiveThreshold(db, sensor, device, ts);
  const underMaint = isUnderMaintenance(db, device.loftId, ts);
  if (!threshold) {
    state.status = "no_threshold";
    return { stored: true, applied: true, threshold: null };
  }

  const breaching = value < threshold.min || value > threshold.max;

  if (underMaint) {
    // 维护期：不告警，并清零连续越限计数（维护前的连续越限不带入维护后）
    state.breachStreak = 0;
    state.status = "maintenance";
    return { stored: true, applied: true, breaching, suppressed: true, threshold };
  }

  const activeAlert = state.alertId ? db.alerts.find(a => a.id === state.alertId) : null;
  const isActive = activeAlert && (activeAlert.status === ALERT_OPEN || activeAlert.status === ALERT_ACKED);

  if (breaching) {
    state.breachStreak += 1;
    state.status = "breaching";
    if (isActive) {
      // 已在告警中：刷新最近读数
      activeAlert.lastValue = value;
      activeAlert.lastTs = ts;
      activeAlert.peakValue = Math.abs(value - ((threshold.min + threshold.max) / 2)) >
        Math.abs(activeAlert.peakValue - ((threshold.min + threshold.max) / 2)) ? value : activeAlert.peakValue;
    } else if (state.breachStreak >= threshold.consecutive) {
      // 连续越限达到阈值才告警；短时抖动（计数不足）不告警
      const alert = {
        id: genId("alr", ts),
        sensorId: sensor.id,
        deviceId: device.id,
        loftId: device.loftId,
        metric: sensor.metric,
        status: ALERT_OPEN,
        thresholdMin: threshold.min,
        thresholdMax: threshold.max,
        consecutive: threshold.consecutive,
        firstBreachTs: findFirstBreachTs(list, threshold),
        startedAt: ts,
        lastTs: ts,
        lastValue: value,
        peakValue: value,
        recoveredAt: null,
        closedAt: null,
        escalation: 0,
        assignee: null,
        acknowledgedAt: null,
        acknowledgedBy: null
      };
      db.alerts.unshift(alert);
      state.alertId = alert.id;
      pushEvent(db, "alert_raised", {
        alertId: alert.id, sensorId: sensor.id, metric: sensor.metric,
        value, min: threshold.min, max: threshold.max, consecutive: state.breachStreak
      }, ts);
    }
  } else {
    // 回到限值内
    if (isActive) {
      // 恢复后自动结束（置为 recovered，等待人工关闭）
      activeAlert.status = ALERT_RECOVERED;
      activeAlert.recoveredAt = ts;
      activeAlert.lastTs = ts;
      activeAlert.lastValue = value;
      state.alertId = null;
      state.breachStreak = 0;
      state.status = "ok";
      pushEvent(db, "alert_recovered", { alertId: activeAlert.id, sensorId: sensor.id, ts }, ts);
    } else {
      // 未达告警连续次数即恢复：抖动自然消解，不产生任何告警
      state.breachStreak = 0;
      state.status = "ok";
    }
  }
  return { stored: true, applied: true, breaching, threshold, suppressed: false };
}

function findFirstBreachTs(list, threshold) {
  // 从最新向前找连续越限段起点
  let start = list[list.length - 1]?.ts ?? null;
  let run = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.value < threshold.min || r.value > threshold.max) {
      run++;
      start = r.ts;
    } else {
      if (run > 0) break;
    }
  }
  return start;
}

// 上报整批。返回 {duplicated, ingested, late, results}
// 重复批次整体幂等：原样返回首次结果，不重复计数。
export function ingestBatch(db, input, now = Date.now(), idempotency = null) {
  if (idempotency && idempotency[input.batchId]) {
    return idempotency[input.batchId];
  }
  // 重复批次优先幂等回放：不再重新校验，原样返回首次结果
  if (db.batches[input.batchId]) {
    const first = db.batches[input.batchId];
    const result = {
      duplicated: true,
      batchId: input.batchId,
      deviceId: first.deviceId,
      ingested: first.count,
      late: first.late || 0,
      results: first.results || [],
      at: first.at
    };
    if (idempotency) idempotency[input.batchId] = result;
    return result;
  }
  // 首次批次：先整批校验，任一记录不合法则抛错（事务整体回滚，无任何计数/读数落库）
  validateBatch(db, input);

  const results = [];
  let ingested = 0;
  let late = 0;
  let primaryDevice = null;

  // 批内按时间排序后推进状态机，保证乱序批次结果确定
  const ordered = input.readings
    .map((r, index) => ({ r, index }))
    .sort((a, b) => Number(a.r.ts) - Number(b.r.ts) || a.index - b.index);

  for (const { r } of ordered) {
    const device = db.devices.find(d => d.id === r.deviceId);
    const sensor = db.sensors.find(s => s.id === r.sensorId);
    const outcome = applyReading(db, sensor, device, Number(r.ts), Number(r.value), input.batchId, now);
    results.push({ sensorId: r.sensorId, ts: Number(r.ts), ...outcome });
    if (outcome.stored) ingested++;
    if (outcome.applied === false && outcome.reason === "out_of_order") late++;
    if (!primaryDevice) primaryDevice = device;

    // 恢复上报即上线（离线设备重新出现）
    if (!device.online) {
      device.online = true;
      device.markedOfflineAt = null;
      pushEvent(db, "device_online", { deviceId: device.id, code: device.code }, Number(r.ts));
    }
    device.lastSeen = Math.max(device.lastSeen || 0, Number(r.ts), now);
  }

  const result = { duplicated: false, batchId: input.batchId, deviceId: primaryDevice?.id || null, ingested, late, results, at: now };
  db.batches[input.batchId] = {
    deviceId: primaryDevice?.id || null,
    count: ingested,
    late,
    results,
    at: now
  };
  if (Object.keys(db.batches).length > 1000) {
    const keys = Object.keys(db.batches);
    delete db.batches[keys[0]];
  }
  if (idempotency) idempotency[input.batchId] = result;
  return result;
}

// ---------- 告警处置 ----------
function getAlert(db, alertId) {
  const alert = db.alerts.find(a => a.id === alertId);
  if (!alert) throw fail(404, "alert_not_found", "告警不存在");
  return alert;
}

function recordAction(db, alert, kind, payload, by, now) {
  const action = {
    id: genId("act", now),
    alertId: alert.id,
    kind, // acknowledge | assign | escalate | close
    by: by || "operator",
    payload: payload || {},
    at: now
  };
  db.actions.push(action);
  pushEvent(db, `alert_${kind}`, { alertId: alert.id, ...payload }, now);
  return action;
}

// 确认：仅 open 可确认；重复/并发第二次必失败（只成功一次）
export function acknowledgeAlert(db, alertId, input = {}, now = Date.now()) {
  const alert = getAlert(db, alertId);
  if (alert.status !== ALERT_OPEN) {
    throw fail(409, "alert_not_ackable", `当前状态 ${alert.status} 不可确认`);
  }
  alert.status = ALERT_ACKED;
  alert.acknowledgedAt = now;
  alert.acknowledgedBy = input.by || "operator";
  return recordAction(db, alert, "acknowledge", { by: alert.acknowledgedBy }, input.by, now);
}

// 指派：open/acked 可指派；幂等键防重复提交；并发串行化后“同人指派”重复拒绝
export function assignAlert(db, alertId, input = {}, now = Date.now()) {
  if (!input.assignee) throw fail(400, "missing_field", "缺少 assignee");
  const alert = getAlert(db, alertId);
  if (alert.status !== ALERT_OPEN && alert.status !== ALERT_ACKED) {
    throw fail(409, "alert_not_assignable", `当前状态 ${alert.status} 不可指派`);
  }
  if (alert.assignee === input.assignee) {
    throw fail(409, "already_assigned", `已指派给 ${input.assignee}`);
  }
  const previous = alert.assignee;
  alert.assignee = input.assignee;
  return recordAction(db, alert, "assign", { from: previous, to: input.assignee }, input.by, now);
}

// 升级：提高升级级别；同级重复升级拒绝；recovered/closed 不可升级
export function escalateAlert(db, alertId, input = {}, now = Date.now()) {
  const alert = getAlert(db, alertId);
  if (alert.status !== ALERT_OPEN && alert.status !== ALERT_ACKED) {
    throw fail(409, "alert_not_escalatable", `当前状态 ${alert.status} 不可升级`);
  }
  const next = Number.isFinite(Number(input.level)) && Number(input.level) > 0
    ? Math.floor(Number(input.level)) : alert.escalation + 1;
  if (next <= alert.escalation) {
    throw fail(409, "escalation_not_higher", `升级级别必须高于当前级别 ${alert.escalation}`);
  }
  const previous = alert.escalation;
  alert.escalation = next;
  return recordAction(db, alert, "escalate", { from: previous, to: next }, input.by, now);
}

// 关闭：只有恢复后（recovered）才能关闭；重复/并发第二次必失败
export function closeAlert(db, alertId, input = {}, now = Date.now()) {
  const alert = getAlert(db, alertId);
  if (alert.status === ALERT_CLOSED) {
    throw fail(409, "already_closed", "告警已关闭");
  }
  if (alert.status !== ALERT_RECOVERED) {
    throw fail(409, "not_recovered", "仅恢复后的告警可关闭");
  }
  alert.status = ALERT_CLOSED;
  alert.closedAt = now;
  alert.closedBy = input.by || "operator";
  return recordAction(db, alert, "close", { by: alert.closedBy }, input.by, now);
}

// ---------- 查询视图 ----------
export function deviceView(db, device, now = Date.now()) {
  const loft = db.lofts.find(l => l.id === device.loftId);
  const sensors = db.sensors.filter(s => s.deviceId === device.id).map(s => ({
    ...s,
    state: db.states[s.id]
  }));
  const activeAlerts = db.alerts.filter(a =>
    a.deviceId === device.id && (a.status === ALERT_OPEN || a.status === ALERT_ACKED)).length;
  return {
    ...device,
    loftName: loft ? loft.name : null,
    underMaintenance: isUnderMaintenance(db, device.loftId, now),
    sensors,
    activeAlerts
  };
}

export function alertView(db, alert) {
  const sensor = db.sensors.find(s => s.id === alert.sensorId);
  const device = db.devices.find(d => d.id === alert.deviceId);
  const loft = db.lofts.find(l => l.id === alert.loftId);
  return {
    ...alert,
    metricLabel: sensor ? sensor.label : alert.metric,
    deviceCode: device ? device.code : null,
    loftName: loft ? loft.name : null,
    actions: db.actions.filter(a => a.alertId === alert.id)
  };
}

export function snapshot(db, now = Date.now()) {
  sweepOffline(db, now);
  return {
    lofts: db.lofts,
    devices: db.devices.map(d => deviceView(db, d, now)),
    sensors: db.sensors,
    thresholds: db.thresholds,
    maintenance: db.maintenance,
    alerts: db.alerts.map(a => alertView(db, a)),
    events: db.events,
    serverTime: now
  };
}

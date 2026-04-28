const state = {
  startedAt: Date.now(),
  requestTotals: new Map(),
  durationAgg: new Map(),
  requestCount: 0,
  errorCount: 0,
  auditWrites: 0,
  processTraceWrites: 0,
  signatureCount: 0,
  activeRequests: 0
};

function keyFor(labels) {
  return JSON.stringify(labels);
}

function labelsToString(labels) {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return entries.length > 0 ? `{${entries.join(',')}}` : '';
}

export function markRequestStart() {
  state.activeRequests += 1;
}

export function recordHttpRequest({ method, route, statusCode, durationMs }) {
  state.activeRequests = Math.max(0, state.activeRequests - 1);
  state.requestCount += 1;
  if (Number(statusCode) >= 500) {
    state.errorCount += 1;
  }

  const labels = {
    method: String(method ?? 'UNKNOWN').toUpperCase(),
    route: String(route ?? 'unknown'),
    status: String(statusCode ?? 0)
  };
  const requestKey = keyFor(labels);
  if (!state.requestTotals.has(requestKey)) {
    state.requestTotals.set(requestKey, { labels, value: 0 });
  }
  state.requestTotals.get(requestKey).value += 1;

  if (!state.durationAgg.has(requestKey)) {
    state.durationAgg.set(requestKey, { labels, sum: 0, count: 0, max: 0 });
  }
  const current = state.durationAgg.get(requestKey);
  current.sum += Number(durationMs ?? 0);
  current.count += 1;
  current.max = Math.max(current.max, Number(durationMs ?? 0));
}

export function incrementAuditWrites() {
  state.auditWrites += 1;
}

export function incrementProcessTraceWrites() {
  state.processTraceWrites += 1;
}

export function incrementSignatureCount() {
  state.signatureCount += 1;
}

export function renderPrometheusMetrics() {
  const lines = [];
  const uptimeSeconds = Math.round((Date.now() - state.startedAt) / 1000);
  const memory = process.memoryUsage();

  lines.push('# HELP akri_uptime_seconds Tiempo desde el arranque del backend.');
  lines.push('# TYPE akri_uptime_seconds gauge');
  lines.push(`akri_uptime_seconds ${uptimeSeconds}`);

  lines.push('# HELP akri_active_requests Solicitudes en curso.');
  lines.push('# TYPE akri_active_requests gauge');
  lines.push(`akri_active_requests ${state.activeRequests}`);

  lines.push('# HELP akri_http_requests_total Total de solicitudes HTTP procesadas.');
  lines.push('# TYPE akri_http_requests_total counter');
  for (const item of state.requestTotals.values()) {
    lines.push(`akri_http_requests_total${labelsToString(item.labels)} ${item.value}`);
  }

  lines.push('# HELP akri_http_request_duration_ms_sum Suma de duración en ms por ruta.');
  lines.push('# TYPE akri_http_request_duration_ms_sum counter');
  lines.push('# HELP akri_http_request_duration_ms_count Conteo de duración en ms por ruta.');
  lines.push('# TYPE akri_http_request_duration_ms_count counter');
  lines.push('# HELP akri_http_request_duration_ms_max Máxima duración en ms por ruta.');
  lines.push('# TYPE akri_http_request_duration_ms_max gauge');
  for (const item of state.durationAgg.values()) {
    lines.push(`akri_http_request_duration_ms_sum${labelsToString(item.labels)} ${item.sum.toFixed(3)}`);
    lines.push(`akri_http_request_duration_ms_count${labelsToString(item.labels)} ${item.count}`);
    lines.push(`akri_http_request_duration_ms_max${labelsToString(item.labels)} ${item.max.toFixed(3)}`);
  }

  lines.push('# HELP akri_http_errors_total Total de errores HTTP 5xx.');
  lines.push('# TYPE akri_http_errors_total counter');
  lines.push(`akri_http_errors_total ${state.errorCount}`);

  lines.push('# HELP akri_audit_writes_total Total de escrituras de auditoría.');
  lines.push('# TYPE akri_audit_writes_total counter');
  lines.push(`akri_audit_writes_total ${state.auditWrites}`);

  lines.push('# HELP akri_process_traces_total Total de trazas de procesos terminados.');
  lines.push('# TYPE akri_process_traces_total counter');
  lines.push(`akri_process_traces_total ${state.processTraceWrites}`);

  lines.push('# HELP akri_signatures_total Total de firmas avanzadas registradas.');
  lines.push('# TYPE akri_signatures_total counter');
  lines.push(`akri_signatures_total ${state.signatureCount}`);

  lines.push('# HELP akri_memory_bytes Uso de memoria del proceso Node.');
  lines.push('# TYPE akri_memory_bytes gauge');
  for (const [key, value] of Object.entries(memory)) {
    lines.push(`akri_memory_bytes${labelsToString({ kind: key })} ${value}`);
  }

  lines.push('');
  return lines.join('\n');
}

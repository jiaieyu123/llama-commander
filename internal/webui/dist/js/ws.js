// ws.js — WebSocket 日志流客户端
// 连接 /api/ws，接收 {type:"log", session_id, level, line, ts} 事件并渲染到控制台。

(function () {
  'use strict';

  const MAX_LINES = 1000;   // 内存缓存上限
  const consoleEl = document.getElementById('log-console');
  const levelSel = document.getElementById('log-level');
  const sessionSel = document.getElementById('log-session');
  const searchInput = document.getElementById('log-search');
  let paused = false;
  let history = [];
  let sessionFilter = '';   // '' = 全部实例

  function wsURL() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/api/ws';
  }

  function shortID(id) {
    return String(id || '').replace(/^session_/, 's').slice(0, 8);
  }

  function matchesFilter(line) {
    if (sessionFilter && line.session_id !== sessionFilter) return false;
    return true;
  }

  function appendLine(line) {
    history.push(line);
    if (history.length > MAX_LINES) history.shift();
    if (paused) return;
    if (matchesFilter(line)) renderLine(line);
  }

  function renderLine(line) {
    const el = document.createElement('div');
    el.className = 'log-line ' + line.level;
    const sid = line.session_id ? `<span class="sid">${esc(shortID(line.session_id))}</span>` : '';
    el.innerHTML = `${sid}<span class="ts">${esc(line.ts)}</span> [${esc(line.level)}] ${esc(line.line)}`;
    if (line.level !== 'INFO' && line.level !== 'METRICS') el.setAttribute('data-level', line.level);
    consoleEl.appendChild(el);
    // 自动滚动（可在日志工具栏关闭）：新日志到达时是否滚到底部
    const autoScroll = document.getElementById('log-autoscroll');
    if (!autoScroll || autoScroll.checked) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function applyFilter() {
    const level = levelSel.value;
    const q = searchInput.value.trim().toLowerCase();
    consoleEl.innerHTML = '';
    history.forEach(function (line) {
      if (level !== 'all' && line.level !== level) return;
      if (q && line.line.toLowerCase().indexOf(q) === -1) return;
      if (!matchesFilter(line)) return;
      renderLine(line);
    });
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  // 设置会话过滤（'' = 全部），由模型库/会话下拉框调用
  function setSessionFilter(id) {
    sessionFilter = id || '';
    applyFilter();
  }

  function connect() {
    const ws = new WebSocket(wsURL());
    ws.onmessage = function (evt) {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'log') appendLine(msg);
        else if (msg.type === 'metrics') handleMetrics(msg);
        else if (msg.type === 'request') handleRequest(msg);
        else if (msg.type === 'progress') handleProgress(msg);
        else if (msg.type === 'test_progress' || msg.type === 'test_done') handleTest(msg);
        else if (msg.type === 'sweep_progress' || msg.type === 'sweep_done') handleSweep(msg);
      } catch (_) { /* ignore non-JSON frames */ }
    };
    ws.onclose = function () {
      setTimeout(connect, 2000); // 自动重连
    };
    return ws;
  }

  // 处理 /metrics 推送（来自服务端 5s 轮询）→ 更新监控面板与图表
  function handleMetrics(msg) {
    const m = msg.metrics || {};
    const sid = msg.session_id || '';
    // 实例级指标缓存 + 实时监控 UI（含外部 API 调用的全局计数）
    window.__liveMetrics = window.__liveMetrics || {};
    if (sid) window.__liveMetrics[sid] = m;
    if (sid && window.Monitor) window.Monitor.update(sid, m);
    const el = id => document.getElementById(id);
    if (typeof m.predicted_per_second === 'number' && isFinite(m.predicted_per_second)) {
      el('m-tps').textContent = m.predicted_per_second.toFixed(1);
      if (window.PerfChart) PerfChart.pushTps(m.predicted_per_second);
    }
    if (typeof m.n_predicted_tokens_total === 'number') {
      el('m-tokens').textContent = m.n_predicted_tokens_total.toLocaleString();
    }
    if (typeof m.kv_cache_usage_ratio === 'number') {
      el('m-kv').textContent = (m.kv_cache_usage_ratio * 100).toFixed(0) + '%';
    }
  }

  // 请求历史（llama-server print_timing 解析 → WS 推送）→ 更新监控请求历史
  function handleRequest(msg) {
    if (window.Monitor && msg.session_id) window.Monitor.updateRequests(msg.session_id, msg.req || {});
  }

  // 处理下载进度推送 → 更新 HF 弹窗进度条
  function handleProgress(msg) {
    if (window.HFProgress) window.HFProgress.update(msg);
  }

  // 批量测试进度/完成 → 更新测试弹窗
  function handleTest(msg) {
    if (window.TestBatch) window.TestBatch.update(msg);
  }

  // 参数扫描进度/完成 → 更新扫描结果
  function handleSweep(msg) {
    if (window.TestBatch && window.TestBatch.updateSweep) window.TestBatch.updateSweep(msg);
  }

  // 事件绑定
  levelSel.addEventListener('change', applyFilter);
  sessionSel.addEventListener('change', function () { setSessionFilter(this.value); });
  searchInput.addEventListener('input', applyFilter);
  document.getElementById('btn-log-pause').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? '▶ 继续' : '⏸ 暂停';
  });
  // 打开当前筛选实例的 Web 界面（无筛选 → 第一个运行实例）
  const openUiBtn = document.getElementById('btn-log-open-ui');
  if (openUiBtn) openUiBtn.addEventListener('click', function () {
    if (window.openInstanceUI) window.openInstanceUI(sessionFilter || '');
    else alert('没有运行中的实例');
  });
  document.getElementById('btn-log-clear').addEventListener('click', function () {
    history = [];
    consoleEl.innerHTML = '';
  });
  document.getElementById('btn-log-export').addEventListener('click', function () {
    const text = history.map(l => `${l.ts} [${l.level}] ${l.line}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'llama-commander-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.log';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.LogConsole = {
    connect: connect,
    applyFilter: applyFilter,
    append: appendLine,
    setSessionFilter: setSessionFilter
  };
})();

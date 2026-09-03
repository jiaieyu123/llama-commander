// app.js — Llama Launcher 前端主逻辑（完整修复版）
(function () {
  'use strict';

  const API = {
    health: '/api/health',
    system: '/api/system',
    bundles: '/api/bundles',
    analyze: '/api/bundles/analyze',
    import: '/api/bundles/import',
    scan: '/api/bundles/scan',
    recommend: '/api/recommend',
    sessions: '/api/sessions',
    insights: '/api/insights',
    start: '/api/sessions/start',
    cache: '/api/cache',
    cacheDelete: '/api/cache/delete',
    cacheImport: '/api/cache/import',
    cacheExport: '/api/cache/export',
    hfList: '/api/hf/list',
    hfDownload: '/api/hf/download',
    debugProxy: '/api/debug/proxy',
    mcpList: '/api/mcp',
    mcpAdd: '/api/mcp',
    mcpStatus: '/api/mcp/status',
    mcpTemplates: '/api/mcp/templates',
    mcpCheckEnv: '/api/mcp/check-env',
    mcpTest: '/api/mcp/test',
    configGet: '/api/config',
    configPut: '/api/config',
    configKey: '/api/config/key',
    configSearchKeys: '/api/config/search-keys',
    fsList: '/api/fs/list',
    parse: '/api/parse',
    preview: '/api/preview',
    params: '/api/params',
    testBatch: '/api/test/batch',
    testSweep: '/api/test/sweep',
    testCancel: '/api/test/cancel',
    testHistory: '/api/test/history'
  };

  let bundles = [];
  let selectedId = '';
  let paramDefs = [];

  // ── 测试状态管理 ───────────────────────────
  const TestStore = {
    type: null,           // 'batch' | 'sweep'
    running: false,
    jobId: null,
    items: [],            // 指向 batchItems 或 sweepItems
    batchItems: [],
    sweepItems: [],
    sweepMode: 'exhaustive',
    lastBest: null,
    totalCombos: 0,

    reset(type) {
      this.type = type;
      this.running = false;
      this.jobId = null;
      if (type === 'batch') {
        this.batchItems = [];
        this.items = this.batchItems;
      } else if (type === 'sweep') {
        this.sweepItems = [];
        this.items = this.sweepItems;
      } else {
        this.items = [];
      }
      this.lastBest = null;
      this.totalCombos = 0;
      const startBtn = document.getElementById('test-start');
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = type === 'sweep' ? '▶ 开始扫描' : '▶ 开始测试';
      }
      const cancelBtn = document.getElementById('test-cancel');
      if (cancelBtn) { cancelBtn.hidden = true; cancelBtn.disabled = false; }
      const exportBtn = document.getElementById('test-export');
      if (exportBtn) exportBtn.hidden = true;
      const snapBtn = document.getElementById('test-savesnap');
      if (snapBtn) snapBtn.hidden = true;
      const snapRename = document.getElementById('btn-snap-rename');
      if (snapRename) snapRename.hidden = true;
      const saveCfg = document.getElementById('test-savecfg');
      if (saveCfg) saveCfg.hidden = true;
      const saveCfgRename = document.getElementById('btn-savecfg-rename');
      if (saveCfgRename) saveCfgRename.hidden = true;
      document.getElementById('savecfg-row').hidden = true;
      document.getElementById('snap-row').hidden = true;
      resetTestProgress();
      hideStage();
      document.getElementById('test-summary').textContent = '';
    },

    setRunning(jobId, total) {
      this.running = true;
      this.jobId = jobId;
      this.totalCombos = total;
      const startBtn = document.getElementById('test-start');
      startBtn.disabled = true;
      startBtn.textContent = this.type === 'sweep' ? '⏳ 扫描中…' : '⏳ 测试中…';
      const cancelBtn = document.getElementById('test-cancel');
      cancelBtn.hidden = false;
      cancelBtn.disabled = false;
      setTestProgress(0, total, `0 / ${total}`);
    },

    stopRunning() {
      this.running = false;
      this.jobId = null;
      const startBtn = document.getElementById('test-start');
      startBtn.disabled = false;
      startBtn.textContent = this.type === 'sweep' ? '▶ 再次扫描' : '▶ 再次测试';
      document.getElementById('test-cancel').hidden = true;
    },

    updateBatchItem(index, data) {
      if (!this.batchItems[index]) this.batchItems[index] = {};
      Object.assign(this.batchItems[index], data);
      renderTestResult();
    },

    updateSweepItem(index, data) {
      if (!this.sweepItems[index]) this.sweepItems[index] = {};
      Object.assign(this.sweepItems[index], data);
      renderSweepResult();
    },

    finish(results, cancelled) {
      this.stopRunning();
      document.getElementById('test-export').hidden = results.length === 0;
      document.getElementById('test-savesnap').hidden = results.length === 0;
      document.getElementById('btn-snap-rename').hidden = results.length === 0;
      if (this.type === 'sweep' && !cancelled && this.lastBest) {
        document.getElementById('test-savecfg').hidden = false;
        document.getElementById('btn-savecfg-rename').hidden = false;
        document.getElementById('savecfg-row').hidden = true;
      } else {
        document.getElementById('test-savecfg').hidden = true;
        document.getElementById('btn-savecfg-rename').hidden = true;
      }
      const ok = results.filter(r => r.status === 'ok').length;
      const summary = cancelled
        ? `⏹ 已取消（完成 ${results.length} 个）`
        : `🏁 完成：✅ ${ok} / ${results.length}`;
      document.getElementById('test-summary').textContent = summary;
      setTestProgress(results.length, results.length, '完成');
    }
  };

  // ── 工具 ──────────────────────────────
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    return fetch(path, opts).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.statusText); });
      if (r.status === 204) return null;
      return r.json();
    });
  }

  function $(id) { return document.getElementById(id); }

  function genAPIKey() {
    const bytes = new Uint8Array(32);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += ALPHA[bytes[i] % ALPHA.length];
    return 'sk-' + s;
  }

  function flashBtn(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1200);
  }

  function showToast(msg, type) {
    let wrap = $('toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toast-wrap';
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 300);
    }, 3200);
  }

  function flashSelect(sel) {
    if (!sel) return;
    sel.classList.remove('flash-ok');
    void sel.offsetWidth;
    sel.classList.add('flash-ok');
    setTimeout(function () { sel.classList.remove('flash-ok'); }, 1200);
  }

  function fallbackCopy(txt) {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  function copyKey(txt, btn) {
    if (!txt) { flashBtn(btn, '空'); return; }
    const ok = function () { flashBtn(btn, '✓'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(ok).catch(function () { fallbackCopy(txt); ok(); });
    } else { fallbackCopy(txt); ok(); }
  }

  function toggleKeyVisibility(input, btn) {
    if (input.type === 'password' && !input.value && cfgHasAPIKey) {
      api(API.configKey).then(function (r) {
        input.value = r.key || '';
        input.type = 'text';
        btn.textContent = '🙈';
      }).catch(function () { flashBtn(btn, '✗'); });
      return;
    }
    if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
    else { input.type = 'password'; btn.textContent = '👁'; }
  }

  function autoFillGlobalKey() {
    const el = $('p-api_key');
    if (!el || el.value.trim() !== '') return;
    api(API.configKey).then(function (r) {
      if (r.key && !$('p-api_key').value) {
        $('p-api_key').value = r.key;
        refreshPreview();
      }
    }).catch(function () { /* 无 key 或请求失败时静默 */ });
  }

  // ── 进度条 / 阶段 ───────────────────────
  function setTestProgress(done, total, label) {
    const wrap = document.getElementById('test-progress');
    if (!wrap) return;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
    const fill = document.getElementById('test-progress-fill');
    const lab = document.getElementById('test-progress-label');
    if (fill) fill.style.width = pct + '%';
    if (lab) lab.textContent = label || (pct + '%');
    wrap.hidden = false;
  }

  function resetTestProgress() {
    const wrap = document.getElementById('test-progress');
    if (!wrap) return;
    wrap.hidden = true;
    const fill = document.getElementById('test-progress-fill');
    if (fill) fill.style.width = '0%';
  }

  const STAGES = ['queued', 'validating', 'auditing', 'warming_up', 'benchmarking', 'cleaning'];
  function setStage(stage) {
    const bar = document.getElementById('stage-bar');
    if (!bar || !stage || STAGES.indexOf(stage) < 0) return;
    bar.hidden = false;
    const cur = STAGES.indexOf(stage);
    bar.querySelectorAll('.stage-chip').forEach(chip => {
      const idx = STAGES.indexOf(chip.dataset.stage);
      chip.classList.toggle('active', idx === cur);
      chip.classList.toggle('done', idx < cur);
    });
  }

  function hideStage() {
    const bar = document.getElementById('stage-bar');
    if (bar) bar.hidden = true;
  }

  // ── 初始化 ────────────────────────────
  function init() {
    // 获取硬件信息
    api(API.system).then(r => {
      window.__hardware = r.hardware || {};
    }).catch(() => {});
    PerfChart.init();
    LogConsole.connect();
    refreshAll();
    autoFillGlobalKey();
    setInterval(refreshStatus, 5000);
    setInterval(updateUptimes, 1000);

    $('btn-refresh-models').addEventListener('click', refreshBundles);
    $('model-select').addEventListener('change', onModelChange);
    $('test-config-select').addEventListener('change', function () { if (selectedId && this.value) applySelectedConfig(); });
    $('btn-apply-config').addEventListener('click', function () { if ($('test-config-select').value) applySelectedConfig(); });
    $('btn-optimize').addEventListener('click', onOptimize);
    $('btn-params-help').addEventListener('click', openParamsHelp);
    loadParams();
    // ---- 新增：参数搜索与折叠功能初始化 ----
    initParamSearch();
    loadGroupStates();
    // v4：整行组标题可点击折叠（点标题/箭头任意处切换，不拦字段交互）
    document.querySelectorAll('.cfg-group').forEach(function (group) {
      const head = group.querySelector(':scope > legend');
      if (!head) { return; }
      head.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('input,select,button,a,label')) { return; }
        const key = group.dataset.group;
        group.classList.toggle('collapsed');
        const states = JSON.parse(localStorage.getItem('paramGroupStates') || '{}');
        states[key] = group.classList.contains('collapsed') ? 'collapsed' : 'expanded';
        localStorage.setItem('paramGroupStates', JSON.stringify(states));
      });
    });
    // ---- 结束新增 ----
    document.querySelectorAll('.preset[data-target]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        const target = document.getElementById(sel.dataset.target);
        if (!target || sel.value === '') return;
        target.value = sel.value;
        sel.value = '';
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    $('btn-start').addEventListener('click', onStart);
    $('btn-stop').addEventListener('click', onStop);
    $('btn-restart').addEventListener('click', onRestart);
    $('btn-open-ui').addEventListener('click', function () {
      getRunning().then(function (running) {
        if (!running.length) { flashBtn($('btn-open-ui'), '无运行实例'); return; }
        const mine = selectedId ? running.filter(s => s.bundle_id === selectedId) : [];
        const target = mine[0] || running[0];
        window.open('http://127.0.0.1:' + target.port, '_blank');
      });
    });
    $('btn-library').addEventListener('click', openLibrary);
    $('btn-debug').addEventListener('click', openDebugModal);
    $('btn-monitor').addEventListener('click', function () { Monitor.open(); });
    $('btn-monitor-refresh').addEventListener('click', function () { Monitor.refresh(); });
    $('btn-monitor-export').addEventListener('click', function () { Monitor.export(); });
    const monR2 = $('btn-monitor-refresh2');
    if (monR2) monR2.addEventListener('click', function () { Monitor.refresh(); flashBtn(monR2, '已刷新'); });
    const monE2 = $('btn-monitor-export2');
    if (monE2) monE2.addEventListener('click', function () { Monitor.export(); });
    $('btn-insights').addEventListener('click', openInsights);
    $('insights-refresh').addEventListener('click', loadInsights);
    $('btn-mcp').addEventListener('click', openMCPModal);
    $('mcp-refresh').addEventListener('click', loadMCP);
    $('mcp-add').addEventListener('click', addMCP);
    $('btn-settings').addEventListener('click', openSettings);
    $('set-save').addEventListener('click', saveSettings);
    $('btn-apikey').addEventListener('click', openAPIKeyModal);
    $('ak-refresh').addEventListener('click', function () { loadAPIKeyState(); loadSysResource(); renderAPIKeyMonitor(); });
    $('ak-key-gen').addEventListener('click', function () {
      $('ak-api-key').value = genAPIKey();
      akAPIKeyChanged = true;
      $('ak-key-hint').textContent = '🎲 已生成随机 Key（256 位），点击 💾 保存后自动注入到每个实例。';
    });
    $('ak-key-copy').addEventListener('click', function () {
      const kInput = $('ak-api-key');
      if (!kInput.value && cfgHasAPIKey) {
        api(API.configKey).then(function (r) {
          if (r.key) copyKey(r.key, $('ak-key-copy'));
          else flashBtn($('ak-key-copy'), '空');
        }).catch(function () { flashBtn($('ak-key-copy'), '✗'); });
      } else {
        copyKey(kInput.value, this);
      }
    });
    $('ak-key-toggle').addEventListener('click', akToggleVisibility);
    $('ak-key-clear').addEventListener('click', function () {
      akAPIKeyChanged = true;
      $('ak-api-key').value = '';
      $('ak-key-hint').textContent = '🔓 保存后将清除已存 API Key';
    });
    $('ak-key-save').addEventListener('click', saveAPIKey);
    $('ak-api-key').addEventListener('input', function () { akAPIKeyChanged = true; });
    $('ak-brave-toggle').addEventListener('click', akBraveToggleVisibility);
    $('ak-tavily-toggle').addEventListener('click', akTavilyToggleVisibility);
    $('ak-search-save').addEventListener('click', saveSearchKeys);
    $('ak-brave-key').addEventListener('input', function () { akBraveKeyChanged = true; });
    $('ak-tavily-key').addEventListener('input', function () { akTavilyKeyChanged = true; });
    bindDraftMatchUI();
    document.querySelectorAll('#apikey-modal [data-close]').forEach(function (btn) {
      btn.addEventListener('click', closeAPIKeyModal);
    });
    $('p-key-gen').addEventListener('click', function () {
      $('p-api_key').value = genAPIKey();
      refreshPreview();
    });
    $('p-key-copy').addEventListener('click', function () { copyKey($('p-api_key').value, this); });
    $('p-key-toggle').addEventListener('click', function () { toggleKeyVisibility($('p-api_key'), this); });
    $('btn-drawer-close').addEventListener('click', closeLibrary);
    $('btn-scan-dir').addEventListener('click', openScanModal);
    $('btn-test').addEventListener('click', openTestModal);
    $('btn-test-params').addEventListener('click', function () {
      const box = $('test-params');
      box.hidden = !box.hidden;
      this.textContent = box.hidden ? '⚙️ 测试参数 ▾' : '⚙️ 测试参数 ▴';
    });
    $('test-cancel').addEventListener('click', cancelTestRun);
    $('test-export').addEventListener('click', exportTestReport);
    if ($('test-savesnap')) $('test-savesnap').addEventListener('click', function () { saveCurrentSnapshot(false); });
    if ($('btn-snap-rename')) $('btn-snap-rename').addEventListener('click', function () { saveCurrentSnapshot(true); });
    if ($('btn-savecfg-rename')) $('btn-savecfg-rename').addEventListener('click', function () { saveBestConfig(true); });
    if ($('snap-confirm')) $('snap-confirm').addEventListener('click', function () { confirmSnapshot(); });
    if ($('snap-cancel')) $('snap-cancel').addEventListener('click', cancelSnapshot);
    if ($('hist-filter')) $('hist-filter').addEventListener('change', renderTestHistory);
    $('btn-hist-clear').addEventListener('click', clearTestHistory);
    $('btn-hist-refresh').addEventListener('click', renderTestHistory);
    $('test-start').addEventListener('click', onTestStart);
    $('btn-test-selectall').addEventListener('click', selectAllTestModels);
    $('btn-test-selectnone').addEventListener('click', clearTestModels);
    document.getElementById('test-models').addEventListener('change', function (e) {
      if (e.target && e.target.matches('.tm')) updateTestModelCount();
    });
    $('test-savecfg').addEventListener('click', function () { saveBestConfig(false); });
    $('savecfg-confirm').addEventListener('click', function () { saveConfigNow(); });
    $('savecfg-cancel').addEventListener('click', function () {
      document.getElementById('savecfg-row').hidden = true;
      document.getElementById('test-savecfg').hidden = false;
      document.getElementById('btn-savecfg-rename').hidden = false;
    });
    $('test-tabs').addEventListener('click', function (e) {
      const btn = e.target.closest('.tab');
      if (btn) switchTestTab(btn.dataset.tab);
    });
    document.querySelectorAll('.sweep-modebar .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        TestStore.sweepMode = c.dataset.smode;
        document.querySelectorAll('.sweep-modebar .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
        TestStore.sweepItems = [];
        TestStore.lastBest = null;
        document.getElementById('test-summary').textContent = '';
        resetTestProgress();
        document.getElementById('test-savecfg').hidden = true;
        document.getElementById('savecfg-row').hidden = true;
        document.getElementById('btn-sweep-fillall').hidden = TestStore.sweepMode !== 'greedy';
        renderSweepResult();
        updateSweepEstimate();
        document.getElementById('test-start').textContent = TestStore.sweepMode === 'greedy' ? '▶ 开始寻优' : '▶ 开始扫描';
      });
    });
    $('btn-sweep-fillall').addEventListener('click', fillAllSweepParams);
    document.querySelectorAll('.scenario-bar .chip[data-scenario]').forEach(function (c) {
      c.addEventListener('click', function () { applyScenario(c.dataset.scenario); });
    });
    $('btn-sweep-clear').addEventListener('click', clearAllSweepParams);
    if ($('btn-sweep-all')) $('btn-sweep-all').addEventListener('click', showAllSweepParams);
    if ($('sweep-add-search')) $('sweep-add-search').addEventListener('input', sweepAddFilter);
    $('sweep-radar-close').addEventListener('click', function () { $('sweep-radar-wrap').hidden = true; });
    $('btn-sweep-settings').addEventListener('click', function () {
      const box = $('sweep-settings');
      box.hidden = !box.hidden;
      this.textContent = box.hidden ? '⚙️ 扫描设置 ▾' : '⚙️ 扫描设置 ▴';
    });
    $('sweep-add-param').addEventListener('change', onAddSweepParam);
    $('sweep-chart-metric').addEventListener('change', renderSweepChart);
    document.getElementById('sweep-result').addEventListener('click', function (e) {
      const btn = e.target.closest('.t-audit');
      if (!btn) return;
      const it = TestStore.sweepItems[parseInt(btn.dataset.audit, 10)];
      if (!it || !it.audit || !it.audit.length) return;
      let box = document.getElementById('audit-' + btn.dataset.audit);
      if (box) { box.remove(); return; }
      const div = document.createElement('div');
      div.id = 'audit-' + btn.dataset.audit;
      div.innerHTML = auditTableHTML(it.audit);
      btn.closest('.test-row').after(div);
    });
    document.getElementById('test-result').addEventListener('click', function (e) {
      const btn = e.target.closest('.t-audit');
      if (!btn) return;
      const it = TestStore.batchItems.find(function (x) { return x.bundle_id === btn.dataset.audit; });
      if (!it || !it.audit || !it.audit.length) return;
      let box = document.getElementById('audit-' + btn.dataset.audit);
      if (box) { box.remove(); return; }
      const div = document.createElement('div');
      div.id = 'audit-' + btn.dataset.audit;
      div.innerHTML = auditTableHTML(it.audit);
      btn.closest('.test-row').after(div);
    });
    loadSweepAddParamOptions();
    $('sweep-model').addEventListener('change', function () {
      const selId = this.value;
      const sb = bundles.find(function (x) { return x.id === selId; });
      const mxc = sb ? Number(((sb.base_model || {}).metadata || {}).context_length || 0) : 0;
      const sel = $('sw-ctx_size') ? $('sw-ctx_size').closest('.sweep-row').querySelector('.preset') : null;
      fillCtxPreset(sel, mxc);
      applySweepGrey();
    });
    $('btn-hf-download').addEventListener('click', openHFModal);
    $('btn-cache').addEventListener('click', openCacheModal);
    $('hf-list').addEventListener('click', listHFFiles);
    $('hf-repo').addEventListener('keydown', function (e) { if (e.key === 'Enter') listHFFiles(); });
    $('cache-refresh').addEventListener('click', loadCache);

    $('dbg-add-msg').addEventListener('click', addMsgRow);
    $('dbg-send').addEventListener('click', sendDebug);
    $('dbg-stop').addEventListener('click', stopDebug);
    $('dbg-clear').addEventListener('click', clearDebugOutput);
    $('dbg-session').addEventListener('change', renderMsgSample);
    document.querySelectorAll('.dbg-tabs .chip').forEach(function (chip) {
      chip.addEventListener('click', function () { switchDebugTab(chip.dataset.tpl); });
    });
    $('scan-go').addEventListener('click', scanDir);
    $('scan-import').addEventListener('click', importSelected);
    $('scan-browse').addEventListener('click', function () { openFSBrowser('dir', 'scan-dir'); });
    $('set-cache-browse').addEventListener('click', function () { openFSBrowser('dir', 'set-cache-dir'); });
    $('scan-selectall').addEventListener('click', selectAllScan);
    $('scan-selectnone').addEventListener('click', clearScan);
    // 扫描结果勾选变化 → 实时更新计数与导入按钮
    $('scan-result').addEventListener('change', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('sel')) updateScanCount();
    });
    // 参数说明集中板（主面板 + 扫描参数）关闭
    if ($('param-help-close')) $('param-help-close').addEventListener('click', function () { $('param-help-dock').hidden = true; });
    if ($('sweep-help-close')) $('sweep-help-close').addEventListener('click', function () { $('sweep-help-dock').hidden = true; });
    // 测试参数：一键沿用主配置
    if ($('btn-sync-main-test')) $('btn-sync-main-test').addEventListener('click', syncMainToTest);
    $('fs-go').addEventListener('click', function () { loadFS($('fs-path').value.trim()); });
    $('fs-up').addEventListener('click', function () {
      if (fsCurrent.parent) loadFS(fsCurrent.parent);
    });
    $('fs-home').addEventListener('click', function () { loadFS(''); });
    $('fs-select').addEventListener('click', selectFSDir);
    $('fs-path').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadFS($('fs-path').value.trim()); });

    document.querySelectorAll('.modal-overlay').forEach(function (ov) {
      ov.querySelectorAll('[data-close]').forEach(function (btn) {
        btn.addEventListener('click', function () { ov.hidden = true; });
      });
    });

    document.querySelectorAll('#main-tabs .main-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchMainTab(b.dataset.mtab); });
    });
    switchMainTab('setup');

    const sbToggle = $('btn-sidebar-toggle');
    if (sbToggle) sbToggle.addEventListener('click', function () {
      if (window.innerWidth <= 900) {
        document.body.classList.toggle('sidebar-open');
      } else {
        document.body.classList.toggle('sidebar-collapsed');
      }
    });
    const sbSearch = $('sidebar-search');
    if (sbSearch) sbSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        const q = this.value.trim().toLowerCase();
        const hit = bundles.find(function (b) { return b.name.toLowerCase().indexOf(q) >= 0; });
        if (hit) {
          $('model-select').value = hit.id;
          selectedId = hit.id;
          onModelChange();
          switchMainTab('setup');
        }
      }
    });
    const qs = $('btn-quick-start');
    if (qs) qs.addEventListener('click', function () {
      switchMainTab('setup');
      if (selectedId) onStart(); else flashBtn(qs, '请先选择模型');
    });
    const nf = $('btn-notify');
    if (nf) nf.addEventListener('click', function () {
      flashBtn(nf, '暂无新通知');
    });
    const trf = $('btn-top-refresh');
    if (trf) trf.addEventListener('click', function () {
      refreshAll();
      flashBtn(trf, '已刷新');
    });

    applyUISettings(loadUISettings());
    ['ui-theme', 'ui-layout'].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener('change', saveUISettings);
    });
    const uiCp = $('ui-compact');
    if (uiCp) uiCp.addEventListener('change', saveUISettings);
    $('scenario-preset').addEventListener('change', function () {
      if (this.value) applyScenarioPreset(this.value);
    });
    $('btn-scenario-clear').addEventListener('click', function () {
      $('scenario-preset').value = '';
      document.querySelectorAll('[id^="p-"]').forEach(function (el) {
        if (el.type === 'checkbox') { el.checked = false; return; }
        if (el.tagName === 'SELECT') { if (el.options && el.options.length) el.selectedIndex = 0; return; }
        if (el.value !== undefined) el.value = '';
      });
      const id = $('model-select').value;
      const b = bundles.find(function (x) { return x.id === id; });
      applyOfficialDefaults(b);
      const specEl = $('p-spec_type');
      if (specEl && window.__isMtp && !specEl.checked) specEl.checked = true;
      if (specEl && specEl.checked) autoMatchDraft(id, false);
      // 把 checkbox 重新对齐到官方默认（避免 default=true 的开关被清成 false 而关闭）
      if (typeof initCheckboxDefaults === 'function') initCheckboxDefaults();
      refreshPreview();
      runAudit();
      showToast('已填入官方默认值（llama.cpp 默认）', 'ok');
      flashBtn($('btn-scenario-clear'), '已还原');
    });
    $('scan-dir').addEventListener('keydown', function (e) { if (e.key === 'Enter') scanDir(); });

    document.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () { applyPreset(chip.dataset.preset); });
    });

    var auditTimer = null;
    document.querySelectorAll('#config-panel input, #config-panel select').forEach(function (el) {
      el.addEventListener('input', function () {
        if (selectedId) {
          const b = bundles.find(x => x.id === selectedId);
          if (b) updateVRAMEstimate(b);
        }
      });
      el.addEventListener('change', function () {
        if (selectedId) {
          const b = bundles.find(x => x.id === selectedId);
          if (b) updateVRAMEstimate(b);
        }
      });
    });
    function scheduleAudit() {
      clearTimeout(auditTimer);
      auditTimer = setTimeout(runAudit, 300);
    }
  }

  function refreshAll() {
    return Promise.all([refreshBundles(), refreshStatus()]);
  }

  // ── 模型库 ────────────────────────────
  function refreshBundles() {
    return api(API.bundles).then(function (list) {
      bundles = list;
      const sel = $('model-select');
      const prev = selectedId;
      sel.innerHTML = '<option value="">— 请选择模型 —</option>';
      list.forEach(function (b) {
        const opt = document.createElement('option');
        opt.value = b.id;
        const m = (b.base_model && b.base_model.metadata) || {};
        const badge = m.file_type_name ? ' (' + m.file_type_name + ')' : '';
        opt.textContent = b.name + badge;
        sel.appendChild(opt);
      });
      if (prev && list.some(b => b.id === prev)) { sel.value = prev; }
      $('foot-models').textContent = list.length;
      renderLibrary(list);
      onModelChange();
    }).catch(function (e) { console.error(e); });
  }
    function renderLibrary(list) {
    const box = $('library-list');
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint">模型库为空。点击上方"➕ 添加"或"📁 扫描"导入模型。</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (b) {
      const div = document.createElement('div');
      div.className = 'lib-item';
      const m = b.base_model || {};
      const meta = m.metadata || {};
      const comps = [];
      if (b.mmproj && b.mmproj.path) comps.push('📷 视觉');
      if (b.draft_model && b.draft_model.enabled) comps.push('⚡ 草稿');
      if (b.lora_list && b.lora_list.length) comps.push('🧩 LoRA×' + b.lora_list.length);
      if (b.shard_info && b.shard_info.is_sharded) comps.push('🧩 分片');
      const lowName = ((b.name || '') + ' ' + ((b.base_model || {}).path || '')).toLowerCase();
      const hasMtpName = lowName.includes('mtp') || lowName.includes('nextn');
      const tb = tagBadges(b.tags || []);
      const cap = ((hasMtpName && !(b.tags || []).includes('mtp') ? '🧩 MTP ' : '') + tb).trim();
      if (cap) comps.push(cap);
      div.innerHTML = `
        <div class="name">${esc(b.name)}
          <button class="btn small lib-del" data-id="${esc(b.id)}" title="删除">🗑</button>
        </div>
        <div class="meta">
          架构: ${esc(meta.architecture || '-')} | 量化: ${esc(meta.file_type_name || '-')} | ${fmtMB(m.file_size_mb)}
          ${comps.length ? '<br>' + esc(comps.join(' | ')) : ''}
          <br><span style="word-break:break-all">${esc(m.path || '-')}</span>
        </div>`;
      const cfgs = (b.test_configs || []).map(function (c) {
        const cm = c.meta || {};
        const tag = [];
        if (cm.ctx_size) tag.push(cm.ctx_size + ' ctx');
        if (cm.n_gpu_layers !== undefined && cm.n_gpu_layers !== null && cm.n_gpu_layers !== 0) tag.push('GPU' + cm.n_gpu_layers);
        if (cm.tps) tag.push(cm.tps.toFixed(1) + ' tok/s');
        if (cm.mode === 'greedy') tag.push('寻优');
        return '<div class="lib-cfg"><span class="lib-cfg-name" title="' + esc(cm.prompt || '') + '">' + esc(c.name || '未命名') + '</span>' +
          '<span class="lib-cfg-meta">' + esc(tag.join(' · ') || '—') + '</span>' +
          '<button class="btn tiny lib-cfg-apply" data-id="' + esc(b.id) + '" data-cfgid="' + esc(c.id) + '" title="把该配置填入启动参数">⚡套用</button>' +
          '<button class="btn tiny lib-cfg-del" data-id="' + esc(b.id) + '" data-cfgid="' + esc(c.id) + '" title="删除该配置">🗑</button></div>';
      }).join('');
      div.innerHTML += (cfgs ? '<div class="lib-cfgs"><div class="lib-cfgs-title">🧪 测试配置</div>' + cfgs + '</div>' : '');
      div.querySelector('.lib-del').addEventListener('click', function () {
        if (!confirm('确定删除模型 "' + b.name + '"？')) return;
        api('/api/bundles/' + b.id, { method: 'DELETE' }).then(refreshBundles);
      });
      div.querySelectorAll('.lib-cfg-apply').forEach(function (btn) {
        btn.addEventListener('click', function () { applyTestConfig(btn.dataset.id, btn.dataset.cfgid); });
      });
      div.querySelectorAll('.lib-cfg-del').forEach(function (btn) {
        btn.addEventListener('click', function () { deleteTestConfig(btn.dataset.id, btn.dataset.cfgid); });
      });
      box.appendChild(div);
    });
  }

  function openLibrary() { $('library-drawer').classList.add('open'); }
  function closeLibrary() { $('library-drawer').classList.remove('open'); }

  // ── 上下文预设 ──────────────────────────
  const DEFAULT_CTX_PRESET_HTML = '<option value="">▾ 预设</option>' +
    '<option value="2048">2048 短对话</option><option value="4096">4096 标准</option>' +
    '<option value="8192">8192 长对话</option><option value="16384">16384 长文档</option>' +
    '<option value="32768">32768 超长</option><option value="65536">65536 极大</option>' +
    '<option value="131072">131072 原生</option>';
  function roundCtx(n) {
    if (n <= 0) return 0;
    if (n >= 8192) return Math.max(512, Math.round(n / 1024) * 1024);
    return Math.max(128, Math.round(n / 256) * 256);
  }
  function buildCtxPresets(maxCtx) {
    const out = [], seen = {};
    [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].forEach(function (f) {
      const v = roundCtx(maxCtx * f);
      if (v <= 0 || seen[v]) return;
      seen[v] = true;
      const pct = (f * 100) % 1 ? (f * 100).toFixed(1) : String(Math.round(f * 100));
      const lbl = f === 1 ? '原生最大' : '最大' + pct + '%';
      out.push({ v: v, label: v.toLocaleString() + ' ' + lbl });
    });
    return out;
  }
  function fillCtxPreset(sel, maxCtx, fallbackHtml) {
    if (!sel) return;
    if (maxCtx > 0) {
      sel.innerHTML = '<option value="">▾ 预设</option>' + buildCtxPresets(maxCtx).map(function (p) {
        return '<option value="' + p.v + '">' + p.label + '</option>';
      }).join('');
    } else if (fallbackHtml) {
      sel.innerHTML = fallbackHtml;
    }
  }

  // ── 模型选择 / 参数联动 ───────────────
  function onModelChange() {
    const id = $('model-select').value;
    selectedId = id;
    const b = bundles.find(x => x.id === id);
    const meta = $('bundle-meta');
    if (!b) {
      meta.textContent = '📷 视觉: — | ⚡ 草稿: 未启用 | 🏷️ 能力: —';
      window.__isMtp = false;
      $('cfg-row-configs').hidden = true;
      return;
    }
    const vis = (b.mmproj && b.mmproj.path) ? '已绑定' : '未绑定';
    const draft = (b.draft_model && b.draft_model.enabled) ? b.draft_model.spec_type : '未启用';
    const mcp = (b.mcp_servers && b.mcp_servers.length) ? b.mcp_servers.join(', ') : '无';
    const _n = ((b.name || '') + ' ' + ((b.base_model || {}).path || '')).toLowerCase();
    const isMtp = _n.includes('mtp') || _n.includes('nextn') || (b.tags || []).includes('mtp');
    window.__isMtp = isMtp;
    const badges = tagBadges(b.tags || []);
    const capStr = ((isMtp && !(b.tags || []).includes('mtp') ? '🧩 MTP ' : '') + badges).trim();
    meta.textContent = `📷 视觉: ${vis} | ⚡ 草稿: ${draft} | 🧩 MCP: ${mcp} | 🏷️ 能力: ${capStr || '—'}`;

    const mmEl = $('p-mmproj');
    if (mmEl) mmEl.placeholder = (b.mmproj && b.mmproj.path) ? '自动: ' + b.mmproj.path : '未检测到 mmproj，可手动填写';

    const specEl = $('p-spec_type');
    if (specEl && isMtp && !specEl.checked) specEl.checked = true;
    if (isMtp && $('p-model_draft')) $('p-model_draft').value = '';

    // ---- 新增：根据模型类型动态显示/隐藏参数组 ----
    updateParamVisibility(b);
    // ---- 结束新增 ----
    autoMatchDraft(id, true);

    const dp = b.default_params || {};
    if (dp.ctx_size) $('p-ctx_size').value = dp.ctx_size;
    if (dp.n_gpu_layers !== undefined) $('p-n_gpu_layers').value = dp.n_gpu_layers;
    if (dp.flash_attn) $('p-flash_attn').value = dp.flash_attn;
    if (dp.load_mode) $('p-load_mode').value = dp.load_mode;
    if (dp.cpu_moe) $('p-cpu_moe').checked = true;

    const maxCtx = Number(((b.base_model || {}).metadata || {}).context_length || 0);
    const pCtxSel = $('p-ctx_size') ? $('p-ctx_size').closest('.num-wrap').querySelector('.preset') : null;
    fillCtxPreset(pCtxSel, maxCtx, DEFAULT_CTX_PRESET_HTML);

    const cfgSel = $('test-config-select');
    const cfgRow = $('cfg-row-configs');
    const cfgs = b.test_configs || [];
    cfgSel.innerHTML = '';
    if (cfgs.length) {
      const o0 = document.createElement('option');
      o0.value = ''; o0.textContent = '— 模型默认 —';
      cfgSel.appendChild(o0);
      cfgs.forEach(function (c) {
        const cm = c.meta || {};
        const tag = [];
        if (cm.ctx_size) tag.push(cm.ctx_size + ' ctx');
        if (cm.n_gpu_layers !== undefined && cm.n_gpu_layers !== null && cm.n_gpu_layers !== 0) tag.push('GPU' + cm.n_gpu_layers);
        if (cm.tps) tag.push(cm.tps.toFixed(1) + ' tok/s');
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name + (tag.length ? '（' + tag.join('·') + '）' : '');
        cfgSel.appendChild(o);
      });
      cfgSel.value = '';
      cfgRow.hidden = false;
    } else {
      cfgRow.hidden = true;
    }
    refreshPreview();
    runAudit();

    // 新增调用
    updateSpecIndicator(b);
    updateVRAMEstimate(b);
  }

  function bundleIsMTP(b) {
    return b && (b.tags || []).includes('mtp');
  }

  function updateSpecIndicator(b) {
    const dot = document.getElementById('spec-dot');
    const text = document.getElementById('spec-status-text');
    const detail = document.getElementById('spec-status-detail');
    if (!b) {
      dot.className = 'status-dot off';
      text.textContent = '未选择模型';
      detail.textContent = '';
      return;
    }
    const isMtp = bundleIsMTP(b);
    const draftEnabled = b.draft_model && b.draft_model.enabled;
    const specChecked = document.getElementById('p-spec_type').checked;

    if (isMtp) {
      dot.className = 'status-dot mtp';
      text.textContent = 'MTP 头已检测';
      if (specChecked) {
        detail.textContent = '✅ 已启用 MTP 投机解码（无需外部草稿）';
      } else {
        detail.textContent = '⚠️ MTP 头可用，但投机解码未启用（勾选下方开关启用）';
      }
    } else if (draftEnabled && b.draft_model.path) {
      dot.className = 'status-dot on';
      text.textContent = '外部草稿模型';
      const fileName = b.draft_model.path.split(/[\\/]/).pop();
      detail.textContent = specChecked ? `✅ 已启用，草稿：${fileName}` : `⚠️ 草稿已绑定但未启用（勾选开关启用）`;
    } else {
      dot.className = 'status-dot off';
      text.textContent = '投机解码未配置';
      detail.textContent = '无 MTP 头或草稿模型';
    }
  }

  function updateVRAMEstimate(b) {
    const bar = document.getElementById('vram-fill');
    const text = document.getElementById('vram-text');
    const warn = document.getElementById('vram-warn');
    if (!b) {
      bar.style.width = '0%';
      text.textContent = '--';
      warn.textContent = '';
      return;
    }
    const params = collectParams();
    api(API.recommend, {
      method: 'POST',
      body: JSON.stringify({ bundle_id: b.id, scene: '', params: params })
    }).then(r => {
      const rec = r.recommendation;
      if (rec && rec.estimated_vram_gb > 0) {
        const total = rec.estimated_vram_gb;
        const free = (window.__hardware && window.__hardware.free_vram_mb) ? window.__hardware.free_vram_mb / 1024 : 0;
        const pct = free > 0 ? Math.min(100, (total / free) * 100) : 0;
        bar.style.width = pct + '%';
        text.textContent = total.toFixed(1) + ' GB / ' + free.toFixed(1) + ' GB';
        if (pct > 90) {
          bar.style.background = '#f44336';
          warn.textContent = '⚠️ 显存不足！';
        } else if (pct > 70) {
          bar.style.background = '#ff9800';
          warn.textContent = '⚠️ 接近显存上限';
        } else {
          bar.style.background = 'linear-gradient(90deg, #4caf50, #ff9800)';
          warn.textContent = '';
        }
      }
    }).catch(() => {
      bar.style.width = '0%';
      text.textContent = '估算失败';
    });
  }

  function onModelChangeMeta() {
    const id = $('model-select').value;
    const b = bundles.find(x => x.id === id);
    const meta = $('bundle-meta');
    if (!b) {
      meta.textContent = '📷 视觉: — | ⚡ 草稿: 未启用 | 🏷️ 能力: —';
      return;
    }
    const vis = (b.mmproj && b.mmproj.path) ? '已绑定' : '未绑定';
    const draft = (b.draft_model && b.draft_model.enabled) ? b.draft_model.spec_type : '未启用';
    const mcp = (b.mcp_servers && b.mcp_servers.length) ? b.mcp_servers.join(', ') : '无';
    const _n = ((b.name || '') + ' ' + ((b.base_model || {}).path || '')).toLowerCase();
    const isMtp = _n.includes('mtp') || _n.includes('nextn') || (b.tags || []).includes('mtp');
    const badges = tagBadges(b.tags || []);
    const capStr = ((isMtp && !(b.tags || []).includes('mtp') ? '🧩 MTP ' : '') + badges).trim();
    meta.textContent = `📷 视觉: ${vis} | ⚡ 草稿: ${draft} | 🧩 MCP: ${mcp} | 🏷️ 能力: ${capStr || '—'}`;
  }

  // ── 一键优化 ────────────────────────────
  function onOptimize() {
    if (!selectedId) { alert('请先选择模型'); return; }
    const btn = $('btn-optimize');
    btn.disabled = true; btn.textContent = '⏳ 计算中…';
    // 保存当前参数快照
    const oldParams = collectParams();
    api(API.recommend, { method: 'POST', body: JSON.stringify({ bundle_id: selectedId, scene: 'speed', params: oldParams }) })
      .then(function (r) {
        const rec = r.recommendation;
        // 构建新参数对象
        const newParams = {};
        if (rec.ctx_size) { $('p-ctx_size').value = rec.ctx_size; newParams.ctx_size = rec.ctx_size; }
        if (rec.n_gpu_layers !== undefined && rec.n_gpu_layers !== null) { $('p-n_gpu_layers').value = rec.n_gpu_layers; newParams.n_gpu_layers = rec.n_gpu_layers; }
        if (rec.flash_attn) { $('p-flash_attn').value = rec.flash_attn; newParams.flash_attn = rec.flash_attn; }
        if (rec.threads) { $('p-threads').value = rec.threads; newParams.threads = rec.threads; }
        if (rec.kv_cache_k) { $('p-cache_type_k').value = rec.kv_cache_k; newParams.cache_type_k = rec.kv_cache_k; }
        if (rec.kv_cache_v) { $('p-cache_type_v').value = rec.kv_cache_v; newParams.cache_type_v = rec.kv_cache_v; }
        if (rec.load_mode) { $('p-load_mode').value = rec.load_mode; newParams.load_mode = rec.load_mode; }
        if (rec.parallel !== undefined && rec.parallel !== null) { $('p-parallel').value = rec.parallel; newParams.parallel = rec.parallel; }
        $('p-cpu_moe').checked = !!rec.cpu_moe; newParams.cpu_moe = !!rec.cpu_moe;
        if (rec.mmproj_cpu) { $('p-no_mmproj_offload').checked = true; newParams.no_mmproj_offload = true; }
        // 高亮变更的参数
        highlightChangedParams(oldParams, newParams);
        const notes = (rec.notes || []).join('；');
        alert('✨ 一键优化完成\n\n' +
          'GPU 层数: ' + (rec.n_gpu_layers === -1 ? 'auto（全量卸载）' : rec.n_gpu_layers) +
          '\n上下文: ' + rec.ctx_size +
          '\n估算显存: ' + (rec.estimated_vram_gb || 0).toFixed(1) + ' GB' +
          (rec.mmproj_cpu ? '\nmmproj: 走 CPU（省显存给主模型）' : '') +
          (notes ? '\n\n💡 ' + notes : ''));
        refreshPreview();
        runAudit();
      })
      .catch(function (e) { alert('优化失败: ' + e.message); })
      .finally(function () { btn.disabled = false; btn.textContent = '✨ 一键优化'; });
  }

  function detectDraftType(draftPath, isMtpModel) {
    if (isMtpModel) return 'draft-mtp';
    if (!draftPath) return '';
    const lower = String(draftPath).toLowerCase();
    if (lower.indexOf('dspark') >= 0) return 'draft-dspark';
    if (lower.indexOf('dflash') >= 0) return 'draft-dflash';
    if (lower.indexOf('eagle') >= 0) return 'draft-eagle3';
    return 'draft-simple';
  }
  function draftTypeLabel(t) {
    return { 'draft-mtp': '🧠 主模型自带 MTP 头', 'draft-simple': '📦 外部草稿模型', 'draft-dspark': '⚡ dSPARK 扩散草稿', 'draft-dflash': '⚡ dFLASH 扩散草稿', 'draft-eagle3': '⚡ EAGLE3 草稿' }[t] || '';
  }

  function autoMatchDraft(modelId, applyIfChecked) {
    if (!modelId) return;
    const mdEl = $('p-model_draft');
    const mdHint = $('model-draft-hint');
    const candSel = $('draft-candidate-select');
    if (!mdEl || !mdHint) return;
    api('/api/bundles/' + modelId + '/match-draft', { method: 'POST', body: '{}' })
      .then(function (r) {
        const done = function () { window.__specAutoMatching = false; refreshPreview(); runAudit(); };
        if (!r || !r.match || !r.match.length) {
          mdHint.textContent = '⚠️ ' + (r && r.empty_reason ? r.empty_reason : '未找到适配的草稿模型：模型库/同目录中没有可投机的草稿，投机解码无法启用。');
          if (candSel) { candSel.innerHTML = '<option value="">🪄 自动匹配草稿…</option>'; }
          // P0-9：勾选了投机但没有可用候选（非 MTP 且无草稿）→ 自动取消勾选并提示
          const cb = $('p-spec_type');
          if (cb && cb.checked) {
            cb.checked = false;
            mdHint.textContent = '⚠️ 未找到适配草稿且非 MTP 模型，无法启用投机（已自动取消勾选）。';
          }
          return done();
        }
        const top = r.match[0];
        if (candSel) {
          const prev = candSel.value;
          candSel.innerHTML = '<option value="">🪄 自动匹配草稿…</option>' +
            '<option value="__none__">🚫 不使用草稿（留空）</option>';
          r.match.forEach(function (c) {
            const o = document.createElement('option');
            if (c.path) {
              o.value = c.path;
              o.textContent = (c.name || c.path.split(/[\\/]/).pop()) + '（' + (c.reason || '') + '）';
            } else {
              o.value = '';
              o.textContent = '（用主模型自带 MTP 头）';
            }
            candSel.appendChild(o);
          });
          if (prev) candSel.value = prev;
        }
        if (r.has_mtp || (top && !top.path)) {
          if (!mdEl.value.trim()) mdEl.value = '';
          mdHint.textContent = '✅ 主模型自带 MTP 头，启用投机即可（draft-mtp），无需外部草稿。';
          return done();
        }
        const specOn = $('p-spec_type') ? $('p-spec_type').checked : false;
        if (applyIfChecked && !specOn) {
          if (mdEl.value === top.path) mdEl.value = '';
          mdHint.textContent = '💡 未启用投机解码。勾选「🚀 启用投机解码」后将自动匹配草稿并识别格式；不需要投机可保持关闭。';
          return done();
        }
        const alreadySet = mdEl.value.trim();
        if (alreadySet) {
          const cur = alreadySet.replace(/\\/g, '/');
          const isRec = (top.path || '').replace(/\\/g, '/') === cur;
          const sameDir = top.reason && top.reason.indexOf('同目录') === 0;
          if (isRec || sameDir) {
            mdHint.textContent = '✅ 草稿模型匹配（' + (top.reason || '') + '）。';
          } else {
            mdHint.textContent = '⚠️ 当前草稿与推荐不符（推荐: ' + (top.name || top.path) + '），架构不匹配可能导致启动崩溃。建议改用自动匹配值。';
          }
          return done();
        }
        if (top.path) {
          mdEl.value = top.path;
          if (candSel) candSel.value = top.path;
          const dt = detectDraftType(top.path, !!window.__isMtp);
          mdHint.textContent = '🔍 自动匹配草稿: ' + (top.reason || '') + (top.name ? ' · ' + top.name : '') + '　→ 按「' + (draftTypeLabel(dt) || dt || '') + '」投机（可手动改）';
        } else {
          mdEl.value = '';
          mdHint.textContent = '✅ 主模型自带 MTP 头，启用投机即可（draft-mtp），无需外部草稿。';
        }
        done();
      })
      .catch(function () { /* 匹配失败不阻塞 */ });
  }

  function bindDraftMatchUI() {
    const btn = $('btn-match-draft');
    if (btn) btn.addEventListener('click', function () {
      if (!selectedId) { alert('请先选择模型'); return; }
      api('/api/bundles/' + selectedId + '/match-draft', { method: 'POST', body: '{}' })
        .then(function (r) {
          const mdEl = $('p-model_draft');
          const mdHint = $('model-draft-hint');
          const candSel = $('draft-candidate-select');
          if (!mdEl || !r) return;
          if (!r.match || !r.match.length) {
            if (mdHint) mdHint.textContent = '⚠️ ' + (r.empty_reason || '未找到适配的草稿模型：模型库/同目录中没有可投机的草稿，投机解码无法启用。');
            if (candSel) candSel.value = '';
            flashBtn(btn, '✗ 无草稿');
            return;
          }
          const top = r.match[0];
          if (top && top.path) {
            mdEl.value = top.path;
            if (candSel) candSel.value = top.path;
            const dt = detectDraftType(top.path, !!window.__isMtp);
            if (mdHint) mdHint.textContent = '✅ 已自动匹配草稿: ' + (top.reason || '') + (top.name ? ' · ' + top.name : '') + '　→ 按「' + (draftTypeLabel(dt) || dt || '') + '」投机' + ((dt === 'draft-eagle3' || dt === 'draft-dflash' || dt === 'draft-dspark') ? '（⚠️文件名启发，若启动报错请改「投机类型」）' : '');
          } else {
            mdEl.value = '';
            if (mdHint) mdHint.textContent = '✅ 主模型自带 MTP 头，启用投机即可（draft-mtp），无需外部草稿。';
          }
          refreshPreview();
          runAudit();
          flashBtn(btn, '✓ 已匹配');
        })
        .catch(function () { flashBtn(btn, '✗'); });
    });
    const sel = $('draft-candidate-select');
    if (sel) sel.addEventListener('change', function () {
      const mdEl = $('p-model_draft');
      const hint = document.getElementById('draft-match-hint');
      if (!mdEl) return;
      if (sel.value === '__none__') {
        mdEl.value = '';
        hint.textContent = '已选择不使用草稿模型';
      } else if (sel.value) {
        mdEl.value = sel.value;
        const opt = sel.options[sel.selectedIndex];
        hint.textContent = '✅ 已选择：' + opt.textContent;
      } else {
        hint.textContent = '';
      }
      refreshPreview();
      runAudit();
    });
    const mdEl = $('p-model_draft');
    if (mdEl) mdEl.addEventListener('change', function () {
      if (selectedId) autoMatchDraft(selectedId, false);
    });
    const specEl = $('p-spec_type');
    if (specEl) specEl.addEventListener('change', function () {
      if (!selectedId) return;
      if (specEl.checked) {
        window.__specAutoMatching = true;   // 等待自动匹配完成后由 done() 清除
        autoMatchDraft(selectedId, false);
      } else {
        const md = $('p-model_draft');
        if (md) md.value = '';
        const hint = $('model-draft-hint');
        if (hint) hint.textContent = '💡 已关闭投机解码，草稿模型已留空。';
        refreshPreview();
        runAudit();
      }
    });
  }

  // ── 预设 ──────────────────────────────
  const PRESETS = {
    default:  { n_gpu_layers: 0, ctx_size: 4096, temperature: 0.8 },
    speed:    { n_gpu_layers: -1, ctx_size: 2048, flash_attn: 'on', threads: 0 },
    lowvram:  { n_gpu_layers: 0, ctx_size: 2048, cache_type_v: 'q4_0', cache_type_k: 'q8_0' },
    context:  { ctx_size: 8192, flash_attn: 'on', cache_type_v: 'q8_0' },
    code:     { temperature: 0.2, top_p: 0.9 },
    creative: { temperature: 0.9, top_p: 0.95, predict: 2048 }
  };
  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    Object.keys(p).forEach(function (k) {
      const el = $('p-' + k);
      if (el) {
        if (el.type === 'checkbox') el.checked = !!p[k];
        else el.value = p[k];
      }
    });
    refreshPreview();
  }

  // ── 参数说明与帮助 ────────────────────
  const GROUP_LABEL = {
    basic: '📁 基础设置', perf: '⚡ 性能调优', memory: '🧠 内存与加载', cpu: '🔧 CPU 与调度',
    sample: '🎨 生成控制', spec: '🧩 投机解码', source: '📥 模型来源', network: '🌐 网络与安全',
    chat: '🧩 模板与推理', log: '📝 日志与调试'
  };

  function fmtDefault(d) {
    if (d === undefined || d === null) return '';
    if (typeof d === 'string') return d === '' ? '自动 / 未设置' : d;
    return String(d);
  }

  function loadParams() {
    return api(API.params).then(function (r) {
      paramDefs = (r && r.params) || [];
      window.__paramTiers = {};
      window.__paramGuidance = {};
      paramDefs.forEach(function (p) {
        window.__paramTiers[p.key] = p.tier || 'core';
        window.__paramGuidance[p.key] = p.guidance || null;
      });
      initCheckboxDefaults();
      bindParamHoverTips();
      enhanceParamFields();
      addPresetsToAllParams();
      api(API.configGet).then(function (c) {
        const el = $('p-api_key');
        if (!el) return;
        el.title = '仅对本次启动的实例生效；留空 = 自动使用 ⚙️设置 里保存的全局 API Key。' +
          (c.has_api_key ? '\n\n当前已配置全局 Key，留空会自动注入。' : '\n\n当前未配置全局 Key。');
        el.placeholder = c.has_api_key ? '留空=自动用全局 Key' : '可选（未设全局 Key）';
      }).catch(function () { /* 忽略 */ });
      if (!$('tab-sweep').hidden) {
        renderSweepParams();
      }
      // 新增：为输入框显示默认值占位
      paramDefs.forEach(function (p) {
        const el = document.getElementById('p-' + p.key);
        if (el && el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'password') {
          if (p.default !== undefined && p.default !== null && p.default !== '') {
            if (!el.value) {
              el.placeholder = '(默认: ' + p.default + ')';
            }
          }
        }
      });
    }).catch(function () { /* 帮助系统不可用时静默降级 */ });
  }

  var _paramTip = null;
  function getParamTip() {
    if (_paramTip) return _paramTip;
    _paramTip = document.createElement('div');
    _paramTip.id = 'param-tip';
    var s = _paramTip.style;
    s.position = 'fixed'; s.zIndex = '99999'; s.maxWidth = '380px'; s.padding = '10px 12px';
    s.background = '#fff'; s.color = '#333'; s.border = '1px solid #d0d7de'; s.borderRadius = '8px';
    s.boxShadow = '0 6px 20px rgba(0,0,0,.16)'; s.fontSize = '12px'; s.lineHeight = '1.6';
    s.pointerEvents = 'none'; s.opacity = '0'; s.transition = 'opacity .12s'; s.display = 'none';
    document.body.appendChild(_paramTip);
    return _paramTip;
  }
  function paramTipOfField(f) {
    var inp = f.querySelector('input[id^="p-"], select[id^="p-"]');
    if (!inp) return null;
    var key = inp.id.slice(2);
    var p = null;
    (paramDefs || []).forEach(function (x) { if (x.key === key) p = x; });
    var g = window.__paramGuidance && window.__paramGuidance[key];
    if (!p && !g) return null;
    return { key: key, def: p ? p.default : null, help: p ? (p.help || '') : '', g: g || null };
  }
  function showParamTip(x, y, info, label) {
    var tip = getParamTip();
    var title = label || info.key;
    var html = '<div style="font-weight:600;margin-bottom:4px;color:#1f2937">' + esc(title) + '</div>';
    var desc = (info.g && info.g.description) || info.help;
    if (desc && title && desc.indexOf(title) === 0) {
      desc = desc.slice(title.length).replace(/^[\s:：]+/, '');
    }
    if (desc) html += '<div>' + esc(desc) + '</div>';
    var rec = info.g && info.g.recommendation;
    if (rec) html += '<div style="margin-top:5px;color:#2e7d32;font-weight:500">✅ ' + esc(rec) + '</div>';
    if (info.def !== undefined && info.def !== null && info.def !== '') {
      html += '<div style="margin-top:3px;color:#6b7280">默认: ' + esc(String(info.def)) + '</div>';
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var nx = x + 14, ny = y + 14;
    if (nx + tw > window.innerWidth - 8) nx = x - tw - 14;
    if (ny + th > window.innerHeight - 8) ny = y - th - 14;
    tip.style.left = nx + 'px'; tip.style.top = ny + 'px';
    tip.style.opacity = '1';
  }
  function hideParamTip() {
    if (_paramTip) { _paramTip.style.opacity = '0'; _paramTip.style.display = 'none'; }
  }
  function bindParamHoverTips() {
    document.addEventListener('mouseover', function (e) {
      var t = e.target;
      var f = t.closest ? t.closest('.field') : null;
      if (!f) { hideParamTip(); return; }
      var info = paramTipOfField(f);
      if (!info) { hideParamTip(); return; }
      var label = f.querySelector('label');
      var lt = label ? label.textContent.trim().replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '') : '';
      showParamTip(e.clientX, e.clientY, info, lt);
    });
    document.addEventListener('mousemove', function (e) {
      if (_paramTip && _paramTip.style.display !== 'none') {
        var tw = _paramTip.offsetWidth, th = _paramTip.offsetHeight;
        var nx = e.clientX + 14, ny = e.clientY + 14;
        if (nx + tw > window.innerWidth - 8) nx = e.clientX - tw - 14;
        if (ny + th > window.innerHeight - 8) ny = e.clientY - th - 14;
        _paramTip.style.left = nx + 'px'; _paramTip.style.top = ny + 'px';
      }
    });
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget || !(e.relatedTarget.closest && e.relatedTarget.closest('.field'))) {
        hideParamTip();
      }
    });
  }

  function openParamsHelp() {
    $('params-modal').hidden = false;
    if (paramDefs.length) { renderParamsHelp(); return; }
    $('params-body').innerHTML = '<div class="empty-hint">⏳ 加载中…</div>';
    loadParams().then(renderParamsHelp);
  }

  function renderParamsHelp() {
    const groups = {};
    paramDefs.forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
    const order = ['basic', 'perf', 'memory', 'cpu', 'sample', 'spec', 'source', 'network', 'chat', 'log'];
    let html = '<div class="help-hint">💡 鼠标悬停在左侧配置面板的任意字段上，也会显示该参数的默认值与说明。留空的数值字段 = 使用该参数的默认值（自动）。</div>';
    order.forEach(function (g) {
      const list = groups[g];
      if (!list || !list.length) return;
      html += '<div class="help-group"><h4>' + (GROUP_LABEL[g] || g) + '</h4>';
      list.forEach(function (p) {
        const def = fmtDefault(p.default);
        const flag = p.long_flag || p.flag || '';
        html += '<div class="help-item">' +
          '<div class="help-title"><code>' + esc(flag) + '</code> <b>' + esc(p.label) + '</b>' +
          (def ? ' <span class="help-def">默认: ' + esc(def) + '</span>' : '') +
          ((p.help || '').indexOf('✅ 推荐') >= 0 ? ' <span class="help-rec">✅ 推荐</span>' : '') + '</div>' +
          (p.enum && p.enum.length ? '<div class="help-enum">可选值: ' + esc(p.enum.join(' / ')) + '</div>' : '') +
          (p.help ? '<div class="help-text">' + esc(p.help) + '</div>' : '') +
          '</div>';
      });
      html += '</div>';
    });
    $('params-body').innerHTML = html;
  }

  // ── 场景预设 ──────────────────────────
  const SCENARIO_PRESETS = {
    chat: { n_gpu_layers: 0, ctx_size: 8192, batch_size: 2048, flash_attn: 'on', cache_type_k: 'f16', cache_type_v: 'f16' },
    code: { n_gpu_layers: 0, ctx_size: 16384, batch_size: 2048, flash_attn: 'on', cache_type_k: 'f16', cache_type_v: 'f16', temperature: 0.2, top_p: 0.9 },
    doc:  { n_gpu_layers: 0, ctx_size: 32768, batch_size: 1024, flash_attn: 'on', cache_type_k: 'q8_0', cache_type_v: 'q8_0', temperature: 0.1 },
    vram: { n_gpu_layers: 8, ctx_size: 4096, batch_size: 1024, ubatch_size: 256, flash_attn: 'on', cache_type_k: 'q8_0', cache_type_v: 'q8_0', kv_unified: true },
    fast: { n_gpu_layers: -1, ctx_size: 4096, batch_size: 4096, ubatch_size: 1024, flash_attn: 'on', parallel: 1 }
  };

  function applyScenarioPreset(name) {
    const p = SCENARIO_PRESETS[name];
    if (!p) return;
    // 保存旧参数
    const oldParams = {};
    Object.keys(p).forEach(function (k) {
      const el = $('p-' + k);
      if (el) {
        oldParams[k] = el.type === 'checkbox' ? el.checked : el.value;
      }
    });
    // 应用新参数
    Object.keys(p).forEach(function (k) {
      const el = $('p-' + k);
      if (!el || p[k] === undefined) return;
      if (el.type === 'checkbox') el.checked = !!p[k];
      else el.value = p[k];
    });
    refreshPreview();
    if (typeof scheduleAudit === 'function') scheduleAudit();
    flashSelect($('scenario-preset'));
    // 高亮变更的参数（调用顶层 highlightChangedParams，使用 .param-flash 类）
    highlightChangedParams(oldParams, p);
  }

  // ── 主区域 Tab ──────────────────────────
  function switchMainTab(name) {
    document.querySelectorAll('#main-tabs .main-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mtab === name);
    });
    document.querySelectorAll('section.panel[data-mtab]').forEach(function (s) {
      s.classList.toggle('mtab-active', s.dataset.mtab === name);
    });
    const crumbMap = { overview: '📊 性能监控', setup: '⚙️ 模型配置', instances: '🚀 运行实例', console: '📋 控制台' };
    const crumb = $('topbar-crumb');
    if (crumb && crumbMap[name]) crumb.textContent = crumbMap[name];
    if (name === 'overview') {
      try { if (PerfChart.resize) PerfChart.resize(); } catch (_) {}
      try { if (window.Monitor) Monitor.refresh(); } catch (_) {}
    }
    if (name === 'instances') refreshStatus();
    if (name === 'console' && typeof applyLogFilter === 'function') applyLogFilter();
  }

  // ── UI 设置 ────────────────────────────
  const UI_KEY = 'lc-ui-settings';
  function loadUISettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch (_) {}
    return s;
  }
  function applyUISettings(s) {
    document.body.dataset.theme = s.theme || 'dark';
    document.body.dataset.layout = s.layout || 'tabs';
    document.body.dataset.compact = s.compact ? '1' : '0';
    const th = $('ui-theme'); if (th) th.value = s.theme || 'dark';
    const ly = $('ui-layout'); if (ly) ly.value = s.layout || 'tabs';
    const cp = $('ui-compact'); if (cp) cp.checked = !!s.compact;
    if ((s.layout || 'tabs') === 'tabs') {
      const anyActive = document.querySelector('section.panel[data-mtab].mtab-active');
      if (!anyActive) switchMainTab('setup');
    }
    if (s.layout === 'dash' && window.PerfChart) {
      try { if (PerfChart.resize) PerfChart.resize(); } catch (_) {}
    }
  }
  function saveUISettings() {
    const s = {
      theme: $('ui-theme') ? $('ui-theme').value : 'dark',
      layout: $('ui-layout') ? $('ui-layout').value : 'tabs',
      compact: $('ui-compact') ? $('ui-compact').checked : false
    };
    localStorage.setItem(UI_KEY, JSON.stringify(s));
    applyUISettings(s);
  }

  // ── 模型能力徽标 ──────────────────────
  function tagBadges(tags) {
    const m = { mtp: '🧩 MTP', moe: '🌐 MoE', vision: '📷 视觉', reasoning: '🧠 推理', embedding: '📐 嵌入' };
    const out = [];
    (tags || []).forEach(function (t) { if (m[t]) out.push(m[t]); });
    return out.join(' ');
  }

  // ── 命令预览 ──────────────────────────
  // P1-1 根治：参数收集以 registry（/api/params → paramDefs）为唯一事实来源，
  // 并让“未触碰的 checkbox 不收集”，从而让更高层（全局/模型级）默认透传。
  // 投机相关键由 collectSpecParams() 统一管理，避免与通用收集冲突。
  const SPEC_MANAGED_KEYS = {
    spec_type: 1, model_draft: 1, n_gpu_layers_draft: 1,
    spec_draft_threads: 1, spec_draft_threads_batch: 1,
    spec_draft_cpu_mask: 1, spec_draft_cpu_mask_batch: 1,
    spec_draft_prio: 1, spec_draft_prio_batch: 1,
    spec_draft_poll: 1, spec_draft_poll_batch: 1,
    spec_draft_cpu_strict: 1, spec_draft_cpu_strict_batch: 1,
    spec_draft_device: 1, spec_draft_cache_type_k: 1, spec_draft_cache_type_v: 1,
    spec_draft_n_max: 1, spec_draft_n_min: 1, spec_draft_p_split: 1, spec_draft_p_min: 1,
    spec_draft_hf: 1, spec_draft_backend_sampling: 1, spec_draft_override_tensor: 1,
    spec_draft_cpu_moe: 1, spec_draft_n_cpu_moe: 1,
    spec_default: 1, spec_synth_len: 1, spec_synth_rates: 1,
    lookup_cache_static: 1, lookup_cache_dynamic: 1
  };
  // 投机启用且为“外部草稿型”时收集的草稿数值键
  const SPEC_DRAFT_VAL_KEYS = ['n_gpu_layers_draft', 'spec_draft_threads', 'spec_draft_threads_batch',
    'spec_draft_cache_type_k', 'spec_draft_cache_type_v', 'spec_draft_n_max', 'spec_draft_n_min',
    'spec_draft_p_split', 'spec_draft_p_min', 'spec_synth_len', 'spec_synth_rates'];

  var _cbInit = {};     // registry bool 默认（checkbox 三态判定用）
  var _cbTracked = false;

  function defOfKey(k) {
    if (!paramDefs) return null;
    for (var i = 0; i < paramDefs.length; i++) if (paramDefs[i].key === k) return paramDefs[i];
    return null;
  }

  function initCheckboxDefaults() {
    if (!_cbTracked) {
      _cbTracked = true;
      // 记录用户显式触碰 checkbox（此后才收集其布尔值）
      document.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.id && t.id.indexOf('p-') === 0 && t.type === 'checkbox') t.dataset.touched = '1';
      }, true);
    }
    (paramDefs || []).forEach(function (pd) {
      if (pd.kind !== 'bool') return;
      var el = document.getElementById('p-' + pd.key);
      if (!el || el.type !== 'checkbox') return;
      var def = !!pd.default;
      _cbInit[pd.key] = def;
      // 未触碰时把 DOM 对齐到官方/模型默认，如实展示默认状态
      if (!el.dataset.touched) el.checked = def;
    });
  }

  // checkbox 的“默认值”：优先 registry default；paramDefs 未就绪时以 DOM 当前值为准
  function cbDefault(k) {
    if (k in _cbInit) return _cbInit[k];
    var pd = defOfKey(k);
    if (pd) { _cbInit[k] = !!pd.default; return _cbInit[k]; }
    var el = $('p-' + k);
    return el ? !!el.checked : false;
  }

  // 通用收集单个参数：空值跳过；checkbox 未触碰且等于默认 → 不收集（回退更高层）
  function collectOne(p, k) {
    var el = $('p-' + k);
    if (!el) return;
    if (el.type === 'checkbox') {
      var def = cbDefault(k);
      if (el.dataset.touched === '1' || el.checked !== def) p[k] = el.checked;
      return;
    }
    var v = el.value == null ? '' : String(el.value).trim();
    if (v === '') return;
    if (k === 'mmproj_device' && v === 'auto') return;
    p[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
  }

  // 投机参数收集：修复 P0-2（空串非法枚举）/P0-8（none 覆盖 MTP 注入）/
  // P0-9（勾选但无草稿→自动禁用）；并支持 P2-8 手选/逗号多类型与 ngram-*
  function collectSpecParams(p) {
    var specCb = $('p-spec_type');
    if (!specCb) return;
    var isMtpModel = !!window.__isMtp;
    var mdEl = $('p-model_draft');
    var draftPath = mdEl ? String(mdEl.value).trim() : '';
    var pickEl = $('p-spec_type_pick');
    var pick = pickEl ? String(pickEl.value).trim() : '';
    var wipe = function () {
      delete p.model_draft;
      SPEC_DRAFT_VAL_KEYS.forEach(function (k) { delete p[k]; });
    };
    var warn = function (msg) {
      var hint = $('model-draft-hint');
      if (hint) hint.textContent = msg;
    };
    if (!specCb.checked) {
      // 关闭投机 → 显式 none 覆盖模型级 MTP 注入（P0-2/P0-8）
      p.spec_type = 'none';
      wipe();
      return;
    }
    var type = pick || detectDraftType(draftPath, isMtpModel);
    if (!type) {
      // P0-9：勾选但无法确定类型（非 MTP 且无草稿路径）。此处不主动取消勾选——
      // 自动匹配草稿是异步的，若抢跑取消会误伤“即将填入草稿”的流程。
      // UI 的取消与提示统一由 autoMatchDraft 的“无候选”完成回调负责。
      // 后端层面先安全地置 none，防止 UI 显示启用但实际自回归。
      p.spec_type = 'none';
      wipe();
      return;
    }
    var parts = type.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var usesDraft = parts.some(function (s) {
      return s === 'draft-simple' || s === 'draft-eagle3' || s === 'draft-dflash' || s === 'draft-dspark';
    });
    if (usesDraft && !draftPath) {
      specCb.checked = false;   // P0-9
      wipe();
      p.spec_type = 'none';
      warn('⚠️ 所选投机类型需要草稿模型路径，但草稿为空（已自动取消勾选）');
      return;
    }
    p.spec_type = type;
    if (usesDraft) {
      p.model_draft = draftPath;
      SPEC_DRAFT_VAL_KEYS.forEach(function (k) {
        var el = $('p-' + k);
        if (!el) { delete p[k]; return; }
        var v = String(el.value).trim();
        if (v === '') { delete p[k]; return; }
        p[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
      });
    } else {
      wipe();   // MTP / ngram / 混合多类型：无需外部草稿参数
    }
  }

  function collectParams() {
    const p = {};
    // P1-1：以 registry 为唯一事实来源遍历收集（DOM 无控件者自然跳过）
    (paramDefs || []).forEach(function (pd) {
      if (SPEC_MANAGED_KEYS[pd.key]) return;
      collectOne(p, pd.key);
    });
    // 兜底：paramDefs 尚未加载时扫描 DOM 上的全部 p-* 控件
    if (!paramDefs || !paramDefs.length) {
      document.querySelectorAll('input[id^="p-"], select[id^="p-"]').forEach(function (el) {
        var k = el.id.slice(2);
        if (SPEC_MANAGED_KEYS[k]) return;
        collectOne(p, k);
      });
    }
    collectSpecParams(p);
    return p;
  }

  function refreshPreview() {
    const params = collectParams();
    const b = bundles.find(x => x.id === selectedId);
    params.model = b && b.base_model ? b.base_model.path : '';
    api(API.preview, { method: 'POST', body: JSON.stringify({ bundle_id: selectedId, params: params }) })
      .then(function (r) { $('cmd-preview').textContent = r.cli; })
      .catch(function () { /* 未选模型时静默 */ });
  }

  // ── 启动 / 停止 / 重启 ─────────────────
  function onStart() {
    if (!selectedId) { alert('请先选择模型'); return; }
    const body = { bundle_id: selectedId, port: parseInt($('p-port').value, 10) || 8080, params: collectParams() };
    api(API.start, { method: 'POST', body: JSON.stringify(body) })
      .then(function (s) {
        appendLog('INFO', `✅ 实例已启动 → http://127.0.0.1:${s.port} (PID ${s.pid})`);
        refreshStatus();
      })
      .catch(function (e) { alert('启动失败: ' + e.message); });
  }

  function onStop() {
    getRunning().then(function (running) {
      if (!running.length) { alert('没有运行中的实例'); return; }
      if (selectedId) {
        const mine = running.filter(s => s.bundle_id === selectedId);
        if (mine.length) {
          stopSessions(mine);
          return;
        }
      }
      if (running.length === 1) {
        stopSessions(running);
      } else if (confirm('停止全部 ' + running.length + ' 个运行中的实例？')) {
        stopSessions(running);
      }
    });
  }

  function onRestart() {
    getRunning().then(function (running) {
      if (!running.length) { alert('没有运行中的实例'); return; }
      let target = running.find(s => s.bundle_id === selectedId) || running[0];
      if (!confirm('重启实例 "' + target.id + '"？')) return;
      api('/api/sessions/' + target.id + '/restart', { method: 'POST' })
        .then(function (s) { appendLog('INFO', `🔄 实例已重启 → PID ${s.pid}`); refreshStatus(); })
        .catch(function (e) { alert('重启失败: ' + e.message); });
    });
  }

  function getRunning() {
    return api(API.sessions).then(function (list) {
      return list.filter(s => s.status === 'running' || s.status === 'starting');
    }).catch(function () { return []; });
  }

  function stopSessions(sessions) {
    const jobs = sessions.map(function (s) {
      return api('/api/sessions/' + s.id + '/stop', { method: 'POST' });
    });
    Promise.all(jobs)
      .then(function () { appendLog('INFO', '⏹ 已请求停止 ' + sessions.length + ' 个实例'); refreshStatus(); })
      .catch(function (e) { alert('停止失败: ' + e.message); });
  }

  // ── 状态与监控 ────────────────────────
  function refreshStatus() {
    return api(API.sessions).then(function (list) {
      let running = 0, stopped = 0;
      list.forEach(function (s) {
        if (s.status === 'running' || s.status === 'starting') running++;
        else stopped++;
      });
      $('stat-running').textContent = running;
      $('stat-stopped').textContent = stopped;
      $('foot-sessions').textContent = list.filter(s => s.start_time.slice(0, 10) === today()).length;
      renderInstances(list);
      renderSessionFilter(list);
      runAudit();
    }).catch(function () {});
  }

  function renderSessionFilter(list) {
    const sel = $('log-session');
    const current = sel.value;
    const active = list.filter(s => s.status === 'running' || s.status === 'starting');
    sel.innerHTML = '<option value="">全部实例</option>';
    active.forEach(function (s) {
      const b = bundles.find(x => x.id === s.bundle_id);
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = (b ? b.name.slice(0, 20) : s.bundle_id) + ' (:' + s.port + ')';
      sel.appendChild(opt);
    });
    if (current && active.some(s => s.id === current)) sel.value = current;
    if (window.LogConsole) LogConsole.setSessionFilter(sel.value);
  }

  function today() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function renderInstances(list) {
    const box = $('instances');
    const runningSessions = list.filter(s => s.status !== 'stopped');
    if (!runningSessions.length) {
      box.innerHTML = '<div class="empty-hint">暂无运行实例。请在下方选择模型并点击 ▶ 启动。</div>';
      return;
    }
    api('/api/monitor').then(function (r) {
      const healthy = {};
      (r.instances || []).forEach(function (it) {
        const m = it.metrics;
        healthy[it.session_id] = !!(m && (typeof m.n_predicted_tokens_total === 'number' || typeof m.n_prompt_tokens_total === 'number'));
      });
      renderInstanceCards(box, runningSessions, healthy);
    }).catch(function () {
      renderInstanceCards(box, runningSessions, {});
    });
  }

  function sessionAPIKey(s) {
    const args = s.cmdline_args || [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--api-key' && i + 1 < args.length) return args[i + 1];
    }
    return '';
  }

  function renderInstanceCards(box, sessions, healthy) {
    box.innerHTML = '';
    sessions.forEach(function (s) {
      const b = bundles.find(x => x.id === s.bundle_id);
      const div = document.createElement('div');
      div.className = 'instance-card';
      const baseUrl = 'http://127.0.0.1:' + s.port;
      const apiKey = sessionAPIKey(s);
      let dotCls, dotTitle;
      if (s.status === 'crashed') { dotCls = 'off'; dotTitle = '实例已退出，API 不可用'; }
      else if (healthy[s.id]) { dotCls = 'ok'; dotTitle = 'API 在线，外部程序可正常对接'; }
      else { dotCls = 'pending'; dotTitle = '启动中 / 连接中（API 尚未就绪）'; }
      div.innerHTML = `
        <div class="status ${esc(s.status)}">${dot(s.status)} ${esc(s.status)}  PID: ${s.pid || '-'}</div>
        <div class="port">:${s.port}</div>
        <div class="meta">${esc(b ? b.name : s.bundle_id)}</div>
        <div class="meta">⏱ <b data-uptime="${esc(s.id)}" data-start="${esc(s.start_time)}" data-status="${esc(s.status)}">--</b></div>
        <div class="api-ep" title="${esc(dotTitle)}">
          <span class="api-ep-dot ${dotCls}"></span>
          <code class="api-ep-url">${baseUrl}</code>
          <button class="btn tiny" data-copy-api="${baseUrl}" title="复制 OpenAI 兼容 API 接入地址">📋 复制</button>
        </div>${apiKey ? `
        <div class="api-ep" title="本实例的 API Key（外部程序调用时放入 Authorization: Bearer 头）">
          <span class="api-ep-dot key">🔑</span>
          <code class="api-ep-key">${esc(apiKey)}</code>
          <button class="btn tiny" data-copy-key="${esc(apiKey)}" title="复制 API Key">📋 复制</button>
        </div>` : ''}
        <div class="actions">
          <button class="btn small" data-stop="${esc(s.id)}">⏹ 停止</button>
          <button class="btn small" data-restart="${esc(s.id)}">🔄 重启</button>
          <button class="btn small" data-open="${baseUrl}">🔗 打开</button>
        </div>`;
      div.querySelector('[data-stop]').addEventListener('click', function () {
        api('/api/sessions/' + s.id + '/stop', { method: 'POST' })
          .then(refreshStatus)
          .catch(function (e) { alert('停止失败: ' + e.message); });
      });
      div.querySelector('[data-restart]').addEventListener('click', function () {
        if (!confirm('重启实例 "' + s.id + '"？')) return;
        api('/api/sessions/' + s.id + '/restart', { method: 'POST' })
          .then(function () { appendLog('INFO', '🔄 实例已重启'); refreshStatus(); })
          .catch(function (e) { alert('重启失败: ' + e.message); });
      });
      div.querySelector('[data-open]').addEventListener('click', function () {
        window.open(this.dataset.open, '_blank');
      });
      div.querySelector('[data-copy-api]').addEventListener('click', function () {
        copyKey(this.dataset.copyApi, this);
      });
      const keyBtn = div.querySelector('[data-copy-key]');
      if (keyBtn) keyBtn.addEventListener('click', function () {
        copyKey(this.dataset.copyKey, this);
      });
      box.appendChild(div);
    });
    updateUptimes();
  }

  function updateUptimes() {
    document.querySelectorAll('[data-uptime]').forEach(function (el) {
      const start = Date.parse(el.dataset.start);
      if (!start) return;
      if (el.dataset.status === 'crashed' || el.dataset.status === 'stopped') {
        if (el.dataset.status === 'crashed') el.textContent = '已退出';
        return;
      }
      el.textContent = fmtDuration((Date.now() - start) / 1000);
    });
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function appendLog(level, line) {
    if (window.LogConsole) window.LogConsole.append({ ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: level, line: line });
  }

  function dot(s) {
    return s === 'running' ? '●' : s === 'crashed' ? '✖' : '○';
  }

  // ── 配置健康审计 ──────────────────────
  function runAudit() {
    const box = $('audit-box');
    if (!selectedId) {
      box.innerHTML = '<div class="empty-hint">🔍 选择模型后自动运行配置健康审计。</div>';
      return;
    }
    api(API.recommend, { method: 'POST', body: JSON.stringify({ bundle_id: selectedId, scene: '', params: collectParams() }) })
      .then(function (r) {
        const items = (r.audit || []).map(function (it) {
          const icon = it.level === 'error' ? '🔴' : it.level === 'warn' ? '🟡' : '💡';
          const cls = it.level === 'error' ? 'error' : it.level === 'warn' ? 'warn' : 'info';
          return `<div class="audit-item ${cls}">${icon} ${esc(it.message)}</div>`;
        });
        const rec = r.recommendation;
        if (rec && rec.estimated_vram_gb > 0) {
          items.unshift(`<div class="audit-item info">📊 当前配置估算显存占用 ${rec.estimated_vram_gb.toFixed(1)} GB</div>`);
        }
        const oldBanner = box.querySelector('.apply-banner');
        if (oldBanner) oldBanner.remove();
        box.innerHTML = items.join('') || '<div class="audit-item info">✅ 未发现明显问题</div>';
      })
      .catch(function () { box.innerHTML = '<div class="empty-hint">审计不可用。</div>'; });
  }
    // ── 扫描文件夹 ────────────────────────
  let scanCandidates = [];

  function openScanModal() {
    $('scan-modal').hidden = false;
    $('scan-result').innerHTML = '<div class="empty-hint">输入目录后点击"扫描"，将递归发现所有 GGUF 模型并自动捆绑配套文件。</div>';
    $('scan-count').textContent = '已选 0 项';
    $('scan-import').disabled = true;
  }

  function scanDir() {
    const dir = $('scan-dir').value.trim();
    if (!dir) { alert('请输入目录路径'); return; }
    const btn = $('scan-go');
    const status = $('scan-status');
    btn.disabled = true; btn.textContent = '⏳ 扫描中…';
    if (status) status.innerHTML = '<span class="scan-spin">⏳</span> 正在递归扫描并解析模型元数据…<div class="scan-tip">目录越大、单文件越大解析越久（一次全量解析），请耐心等待；完成后会在此列出候选。</div>';
    api(API.scan, { method: 'POST', body: JSON.stringify({ dir: dir }) })
      .then(function (r) {
        scanCandidates = r.candidates || [];
        renderScanResults();
        const skipped = r.skipped || [];
        if (status) {
          status.innerHTML = scanCandidates.length
            ? '✅ 发现 <b>' + scanCandidates.length + '</b> 个候选模型' + (skipped.length ? '（另有 ' + skipped.length + ' 个解析失败被跳过）' : '') + '，勾选后点「📥 批量导入选中」；也可 <b>✅ 全选</b> 后一次性导入。'
            : (skipped.length ? '⚠️ 没有可导入的候选（' + skipped.length + ' 个文件解析失败）。' : '');
        }
        if (skipped.length) {
          const box = $('scan-result');
          const items = skipped.slice(0, 20).map(function (s) {
            return `<div class="audit-item warn">⚠️ ${esc(s)}</div>`;
          }).join('');
          const more = skipped.length > 20 ? `<div class="warns">… 共 ${skipped.length} 个文件被跳过</div>` : '';
          box.insertAdjacentHTML('beforeend',
            `<div class="empty-hint" style="text-align:left;color:var(--yellow)">以下文件解析失败，已跳过（可能损坏 / 非 GGUF / 不支持的格式）：</div>${items}${more}`);
        }
        if (!scanCandidates.length && !skipped.length) {
          $('scan-result').innerHTML = '<div class="empty-hint">未在目录中发现 GGUF 模型。</div>';
        }
      })
      .catch(function (e) {
        $('scan-result').innerHTML = `<div class="audit-item error">🔴 ${esc(e.message)}</div>`;
      })
      .finally(function () { btn.disabled = false; btn.textContent = '🔍 扫描'; });
  }

  function renderScanResults() {
    const box = $('scan-result');
    box.innerHTML = '';
    scanCandidates.forEach(function (c, i) {
      const b = c.bundle;
      const div = document.createElement('div');
      div.className = 'scan-item';
      const warns = (c.warnings || []).map(w => `<div class="warns">⚠️ ${esc(w)}</div>`).join('');
      div.innerHTML = `
        <input type="checkbox" class="sel" data-i="${i}" checked>
        <div>
          <div class="name">${esc(b.name)}</div>
          <div class="meta">${esc(b.base_model.path)}<br>
            架构: ${esc((b.base_model.metadata && b.base_model.metadata.architecture) || '-')} |
            量化: ${esc((b.base_model.metadata && b.base_model.metadata.file_type_name) || '-')} |
            大小: ${fmtMB(b.base_model.file_size_mb)}</div>
          ${warns}
        </div>`;
      box.appendChild(div);
    });
    updateScanCount();
  }

  function updateScanCount() {
    const n = scanCandidates.filter(function (_, i) {
      const cb = document.querySelector(`.scan-item .sel[data-i="${i}"]`);
      return cb && cb.checked;
    }).length;
    $('scan-count').textContent = '已选 ' + n + ' 项';
    $('scan-import').disabled = n === 0;
  }

  function selectAllScan() {
    document.querySelectorAll('.scan-item .sel').forEach(function (cb) { cb.checked = true; });
    updateScanCount();
  }
  function clearScan() {
    document.querySelectorAll('.scan-item .sel').forEach(function (cb) { cb.checked = false; });
    updateScanCount();
  }

  function importSelected() {
    const selected = scanCandidates.filter(function (_, i) {
      const cb = document.querySelector(`.scan-item .sel[data-i="${i}"]`);
      return cb && cb.checked;
    });
    if (!selected.length) return;
    const btn = $('scan-import');
    const status = $('scan-status');
    btn.disabled = true; btn.textContent = '⏳ 导入中…';
    let ok = 0, dup = 0, failed = 0;
    const total = selected.length;
    // 逐个串行导入并实时显示「当前模型 + i/N」进度（单个模型解析较慢，避免长时间无反馈）
    const step = function (i) {
      if (i >= total) {
        btn.disabled = false; btn.textContent = '📥 批量导入选中';
        if (status) status.innerHTML = '';
        $('scan-modal').hidden = true;
        refreshBundles();
        const parts = [];
        if (ok) parts.push('✅ 导入 ' + ok + ' 个');
        if (dup) parts.push('⏭ 跳过已存在 ' + dup + ' 个');
        if (failed) parts.push('❌ 失败 ' + failed + ' 个');
        alert(parts.length ? '完成：' + parts.join(' · ') : '没有新增模型（全部已在模型库）');
        return;
      }
      const c = selected[i];
      const nm = (c.bundle && c.bundle.name) || '';
      if (status) status.innerHTML = '<span class="scan-spin">⏳</span> 正在导入 <b>' + esc(nm) + '</b>… <span class="scan-tip">（' + (i + 1) + ' / ' + total + '）正在解析模型文件，请稍候。</span>';
      api(API.import, { method: 'POST', body: JSON.stringify({ path: c.bundle.base_model.path, name: nm }) })
        .then(function () { ok++; })
        .catch(function (e) {
          if (e && e.message && e.message.indexOf('已在模型库') >= 0) dup++;
          else failed++;
        })
        .finally(function () { step(i + 1); });
    };
    step(0);
  }

  // ── HF 下载 ────────────────────────────
  let hfFiles = [];
  function openHFModal() {
    $('hf-modal').hidden = false;
    $('hf-result').innerHTML = '<div class="empty-hint">输入仓库名后点击"列出 GGUF 文件"。</div>';
    $('hf-status').textContent = '';
    $('hf-mirror').textContent = '';
    $('hf-repo').focus();
  }

  function listHFFiles() {
    const repo = $('hf-repo').value.trim();
    if (!repo) { alert('请输入仓库名'); return; }
    const btn = $('hf-list');
    btn.disabled = true; btn.textContent = '⏳ 查询中…';
    api(API.hfList, { method: 'POST', body: JSON.stringify({ repo: repo }) })
      .then(function (r) {
        hfFiles = r.files || [];
        $('hf-mirror').textContent = '镜像: ' + (r.mirror || '');
        renderHFFiles(repo);
      })
      .catch(function (e) { $('hf-result').innerHTML = `<div class="audit-item error">🔴 ${esc(e.message)}</div>`; })
      .finally(function () { btn.disabled = false; btn.textContent = '📃 列出 GGUF 文件'; });
  }

  function renderHFFiles(repo) {
    const box = $('hf-result');
    if (!hfFiles.length) {
      box.innerHTML = '<div class="empty-hint">该仓库没有 GGUF 文件。</div>';
      return;
    }
    box.innerHTML = '';
    hfFiles.forEach(function (f, i) {
      const div = document.createElement('div');
      div.className = 'scan-item';
      const isMmproj = /mmproj|mm_projector/i.test(f.name);
      const isDraft = /draft/i.test(f.name);
      div.innerHTML = `
        <div>
          <div class="name">${isMmproj ? '📷 ' : isDraft ? '⚡ ' : ''}${esc(f.name)}</div>
          <div class="meta">${fmtSize(f.size)}</div>
          <button class="btn small primary" data-dl="${i}" style="margin-top:6px">⬇️ 下载并导入</button>
        </div>`;
      div.querySelector('[data-dl]').addEventListener('click', function () { downloadHF(repo, f.name); });
      box.appendChild(div);
    });
  }

  function downloadHF(repo, filename) {
    const st = $('hf-status');
    st.textContent = '⏳ 已开始下载 ' + filename + '（进度条见上方，完成后自动入库）';
    api(API.hfDownload, { method: 'POST', body: JSON.stringify({ repo: repo, filename: filename }) })
      .then(function (r) {
        window.HFProgress.update({ job_id: r.job_id, filename: r.filename, done: 0, total: 0 });
        let tries = 0;
        const timer = setInterval(function () {
          tries++;
          refreshBundles();
          if (tries >= 120) clearInterval(timer);
        }, 5000);
      })
      .catch(function (e) { st.textContent = '下载启动失败: ' + e.message; });
  }

  window.HFProgress = (function () {
    const tasks = {};
    function ensure(jobId, filename) {
      if (tasks[jobId]) return tasks[jobId];
      const box = $('hf-downloads');
      const div = document.createElement('div');
      div.className = 'dl-item';
      div.innerHTML = `
        <span class="dl-name">${esc(filename)}</span><span class="dl-status">排队中…</span>
        <div class="dl-progress"><div class="bar"></div></div>`;
      box.insertBefore(div, box.firstChild);
      const t = {
        div: div,
        statusEl: div.querySelector('.dl-status'),
        barEl: div.querySelector('.bar')
      };
      tasks[jobId] = t;
      return t;
    }
    function update(msg) {
      const t = ensure(msg.job_id, msg.filename);
      const pct = msg.total > 0 ? Math.min(100, (msg.done / msg.total) * 100) : 0;
      t.barEl.style.width = pct + '%';
      if (msg.finished) {
        t.div.classList.add(msg.success ? 'done' : 'fail');
        t.statusEl.textContent = msg.success ? '✅ 完成（正在自动入库…）' : '❌ 下载失败';
        t.barEl.style.width = msg.success ? '100%' : pct + '%';
      } else {
        t.statusEl.textContent = `${fmtSize(msg.done)} / ${fmtSize(msg.total)} (${pct.toFixed(0)}%)`;
      }
    }
    return { update: update };
  })();

  function fmtSize(bytes) {
    if (!bytes) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, b = bytes;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(1) + ' ' + u[i];
  }

  // ── 缓存管理器 ─────────────────────────
  function openCacheModal() {
    $('cache-modal').hidden = false;
    loadCache();
  }

  function loadCache() {
    const box = $('cache-result');
    box.innerHTML = '<div class="empty-hint">加载中…</div>';
    api(API.cache).then(function (r) {
      $('cache-root').textContent = r.root || '(未找到缓存目录)';
      renderCache(r.entries || []);
    }).catch(function (e) { box.innerHTML = `<div class="audit-item error">🔴 ${esc(e.message)}</div>`; });
  }

  function renderCache(entries) {
    const box = $('cache-result');
    if (!entries.length) {
      box.innerHTML = '<div class="empty-hint">缓存为空。</div>';
      return;
    }
    box.innerHTML = '';
    entries.forEach(function (e, i) {
      const div = document.createElement('div');
      div.className = 'scan-item';
      div.innerHTML = `
        <div>
          <div class="name">${esc(e.filename)}</div>
          <div class="meta">${esc(e.repo_id || 'local')} | ${fmtSize(e.size_mb ? e.size_mb * 1024 * 1024 : 0)}<br>
          <span style="word-break:break-all">${esc(e.path)}</span></div>
          <div class="actions" style="margin-top:6px;display:flex;gap:6px">
            <button class="btn small" data-del="${i}">🗑 删除</button>
            <button class="btn small" data-imp="${i}">📥 导入模型库</button>
          </div>
        </div>`;
      div.querySelector('[data-del]').addEventListener('click', function () {
        if (!confirm('删除缓存条目 "' + e.filename + '"？')) return;
        api(API.cacheDelete, { method: 'POST', body: JSON.stringify({ path: e.path }) })
          .then(loadCache);
      });
      div.querySelector('[data-imp]').addEventListener('click', function () {
        api(API.import, { method: 'POST', body: JSON.stringify({ path: e.path }) })
          .then(function () { alert('✅ 已导入模型库'); refreshBundles(); loadCache(); })
          .catch(function (err) { alert('导入失败: ' + err.message); });
      });
      box.appendChild(div);
    });
  }

  // ── 📡 实时监控 ──────────────────────
  const MonChart = {
    charts: {},
    series: {},
    option: function () {
      return {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        legend: { data: ['输出', '输入', '累计输出'], textStyle: { color: '#8b949e' }, top: 0 },
        grid: { left: 40, right: 52, top: 28, bottom: 22 },
        xAxis: { type: 'category', data: [], axisLine: { lineStyle: { color: '#2a3242' } } },
        yAxis: [
          { type: 'value', name: 'tok/s', splitLine: { lineStyle: { color: '#1c2230' } } },
          { type: 'value', name: 'tok', splitLine: { show: false }, axisLabel: { color: '#8b949e' } }
        ],
        series: [
          { name: '输出', type: 'line', smooth: true, showSymbol: false, yAxisIndex: 0, lineStyle: { color: '#4f8cff', width: 2 }, areaStyle: { color: 'rgba(79,140,255,.12)' }, data: [] },
          { name: '输入', type: 'line', smooth: true, showSymbol: false, yAxisIndex: 0, lineStyle: { color: '#3fb950', width: 2 }, data: [] },
          { name: '累计输出', type: 'line', step: 'end', showSymbol: false, yAxisIndex: 1, lineStyle: { color: '#f0a45e', width: 2 }, data: [] }
        ]
      };
    },
    ensure: function (sid, container, el) {
      if (typeof echarts === 'undefined' || !el) return null;
      const key = sid + '@' + container;
      if (!this.charts[key]) {
        this.charts[key] = echarts.init(el, null, { renderer: 'canvas' });
        this.charts[key].setOption(this.option());
      }
      return this.charts[key];
    },
    replay: function (sid) {
      const s = this.series[sid];
      if (!s) return;
      const prefix = sid + '@';
      for (const key in this.charts) {
        if (key.indexOf(prefix) !== 0) continue;
        const ch = this.charts[key];
        if (!ch) continue;
        ch.setOption({
          xAxis: { data: s.pps.map(function (_, i) { return MonChart.fmt(i, s.pps.length); }) },
          series: [{ data: s.pps }, { data: s.rps }, { data: s.pred }]
        });
      }
    },
    push: function (sid, m) {
      if (!this.series[sid]) this.series[sid] = { pps: [], rps: [], pred: [] };
      const s = this.series[sid];
      s.pps.push(isFinite(m.prompt_per_second) ? m.prompt_per_second : 0);
      s.rps.push(isFinite(m.predicted_per_second) ? m.predicted_per_second : 0);
      s.pred.push(typeof m.n_predicted_tokens_total === 'number'
        ? m.n_predicted_tokens_total : (s.pred.length ? s.pred[s.pred.length - 1] : 0));
      if (s.pps.length > 120) { s.pps.shift(); s.rps.shift(); s.pred.shift(); }
      this.replay(sid);
    },
    fmt: function (idx, len) {
      const t = new Date(Date.now() - (len - 1 - idx) * 5000);
      return t.toLocaleTimeString('zh-CN', { hour12: false });
    },
    resetCharts: function () {
      for (const key in this.charts) { this.charts[key].dispose(); }
      this.charts = {};
    }
  };

  const Monitor = {
    containers: ['monitor-body', 'monitor-inline'],
    active: function () { return this.containers.filter(function (c) { return document.getElementById(c); }); },
    open: function () { $('monitor-modal').hidden = false; this.refresh(); },
    refresh: function () {
      const list = this.active();
      if (!list.length) return;
      MonChart.resetCharts();
      api('/api/monitor').then(function (r) {
        const data = r.instances || [];
        list.forEach(function (cid) {
          const body = document.getElementById(cid);
          if (!body) return;
          if (!data.length) {
            body.innerHTML = '<div class="empty-hint">暂无运行实例。启动模型后这里会实时显示输入/输出 token、速率、并发槽位与 KV 占用。</div>';
            return;
          }
          let html = '';
          data.forEach(function (it) { html += Monitor.card(it); });
          body.innerHTML = html;
        });
        data.forEach(function (it) {
          list.forEach(function (cid) {
            const visible = !!document.getElementById(cid).offsetParent;
            const el = document.querySelector('#' + cid + ' .monitor-card[data-session="' + it.session_id + '"] .monitor-chart');
            if (el && visible) MonChart.ensure(it.session_id, cid, el);
          });
          MonChart.replay(it.session_id);
          const m = (window.__liveMetrics || {})[it.session_id];
          if (m) Monitor.update(it.session_id, m);
          if (it.requests && it.requests.length) Monitor.renderRequests(it.session_id, it.requests);
        });
        list.forEach(function (cid) {
          document.querySelectorAll('#' + cid + ' .mon-big').forEach(function (btn) {
            btn.addEventListener('click', function () { Monitor.openBig(btn.getAttribute('data-sid')); });
          });
        });
      }).catch(function () {
        list.forEach(function (cid) {
          const body = document.getElementById(cid);
          if (body) body.innerHTML = '<div class="empty-hint">监控接口不可用。</div>';
        });
      });
    },
    card: function (it) {
      const m = it.metrics || {};
      const fmt = function (v) { return typeof v === 'number' ? v.toLocaleString() : '--'; };
      const rate = function (v) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(1) : '--'; };
      const kv = (typeof m.kv_cache_usage_ratio === 'number')
        ? (m.kv_cache_usage_ratio * 100).toFixed(0) + '%' : '--';
      return `<div class="monitor-card" data-session="${esc(it.session_id)}">
        <div class="monitor-head"><b>${esc(it.bundle || ('session ' + it.session_id))}</b>
          <span class="monitor-tag">:${it.port}</span>
          <span class="monitor-tag">${it.status === 'running' ? '●' : '◌'} ${it.uptime || '--'}</span>
          <button class="btn small mon-big" data-sid="${esc(it.session_id)}" title="大图与请求历史">📈</button>
        </div>
        <div class="metric-stats">
          <div class="metric"><span class="m-label">⬇ 输入</span><span class="m-value" data-role="prompt">${fmt(m.n_prompt_tokens_total)}</span><span class="m-unit">tok</span></div>
          <div class="metric"><span class="m-label">⬆ 输出</span><span class="m-value" data-role="pred">${fmt(m.n_predicted_tokens_total)}</span><span class="m-unit">tok</span></div>
          <div class="metric"><span class="m-label">⬇ 输入速率</span><span class="m-value" data-role="pps">${rate(m.prompt_per_second)}</span><span class="m-unit">tok/s</span></div>
          <div class="metric"><span class="m-label">⬆ 输出速率</span><span class="m-value" data-role="rps">${rate(m.predicted_per_second)}</span><span class="m-unit">tok/s</span></div>
          <div class="metric"><span class="m-label">🧵 并发槽位</span><span class="m-value" data-role="slots">${fmt(m.slots_processing)}</span></div>
          <div class="metric"><span class="m-label">🧠 KV 占用</span><span class="m-value" data-role="kv">${kv}</span></div>
        </div>
        <div class="monitor-chart" style="height:150px;margin-top:8px"></div>
        <div class="req-history" data-sid="${esc(it.session_id)}"></div>
      </div>`;
    },
    update: function (sid, m) {
      const cards = this.active().map(function (cid) {
        return document.querySelector('#' + cid + ' .monitor-card[data-session="' + sid + '"]');
      }).filter(Boolean);
      if (!cards.length) { this.refresh(); return; }
      cards.forEach(function (card) {
        const set = function (role, txt) {
          const e = card.querySelector('[data-role="' + role + '"]');
          if (e) e.textContent = txt;
        };
        if (typeof m.n_prompt_tokens_total === 'number') set('prompt', m.n_prompt_tokens_total.toLocaleString());
        if (typeof m.n_predicted_tokens_total === 'number') set('pred', m.n_predicted_tokens_total.toLocaleString());
        if (typeof m.prompt_per_second === 'number' && isFinite(m.prompt_per_second)) set('pps', m.prompt_per_second.toFixed(1));
        if (typeof m.predicted_per_second === 'number' && isFinite(m.predicted_per_second)) set('rps', m.predicted_per_second.toFixed(1));
        if (typeof m.slots_processing === 'number') set('slots', m.slots_processing.toLocaleString());
        if (typeof m.kv_cache_usage_ratio === 'number') set('kv', (m.kv_cache_usage_ratio * 100).toFixed(0) + '%');
      });
      MonChart.push(sid, m);
    },
    updateRequests: function (sid, req) {
      if (!req) return;
      window.__reqHistory = window.__reqHistory || {};
      if (!window.__reqHistory[sid]) window.__reqHistory[sid] = [];
      window.__reqHistory[sid].unshift(req);
      if (window.__reqHistory[sid].length > 50) window.__reqHistory[sid].pop();
      this.active().forEach(function (cid) {
        const box = document.querySelector('#' + cid + ' .req-history[data-sid="' + sid + '"]');
        if (box) {
          box.insertAdjacentHTML('afterbegin', reqRow(req));
          while (box.children.length > 10) box.lastChild.remove();
        }
      });
      if (window.__bigSid === sid) this.appendBigRow(req);
    },
    renderRequests: function (sid, list) {
      window.__reqHistory = window.__reqHistory || {};
      window.__reqHistory[sid] = list.slice(0, 50);
      this.active().forEach(function (cid) {
        const box = document.querySelector('#' + cid + ' .req-history[data-sid="' + sid + '"]');
        if (box) box.innerHTML = list.slice(0, 10).map(reqRow).join('');
      });
    },
    openBig: function (sid) {
      const card = document.querySelector('#monitor-body .monitor-card[data-session="' + sid + '"]') ||
        document.querySelector('#monitor-inline .monitor-card[data-session="' + sid + '"]');
      const title = card ? ((card.querySelector('.monitor-head b') || {}).textContent) : sid;
      $('big-title').textContent = '📈 ' + title;
      $('monitor-big-modal').hidden = false;
      window.__bigSid = sid;
      if (typeof echarts !== 'undefined') {
        const el = $('big-chart');
        if (window.__bigChart) { window.__bigChart.dispose(); window.__bigChart = null; }
        window.__bigChart = echarts.init(el, null, { renderer: 'canvas' });
        window.__bigChart.setOption(MonChart.option());
        const s = MonChart.series[sid];
        if (s) window.__bigChart.setOption({
          xAxis: { data: s.pps.map(function (_, i) { return MonChart.fmt(i, s.pps.length); }) },
          series: [{ data: s.pps }, { data: s.rps }, { data: s.pred }]
        });
        if (!window.__bigResizeBound) {
          window.addEventListener('resize', function () { if (window.__bigChart) window.__bigChart.resize(); });
          window.__bigResizeBound = true;
        }
      }
      const hist = (window.__reqHistory || {})[sid] || [];
      $('big-history').innerHTML = hist.length ? hist.map(reqRow).join('') : '<div class="empty-hint">暂无请求记录。发起一次推理后这里会显示。</div>';
    },
    appendBigRow: function (req) {
      const box = $('big-history');
      if (!box) return;
      box.insertAdjacentHTML('afterbegin', reqRow(req));
      while (box.children.length > 50) box.lastChild.remove();
    },
    export: function () {
      const rows = [['实例', '时间', '输入tok', '输出tok', '输入速率', '输出速率', '并发槽位', 'KV%']];
      const mets = window.__liveMetrics || {};
      const seen = {};
      this.active().forEach(function (cid) {
        document.querySelectorAll('#' + cid + ' .monitor-card').forEach(function (card) {
          const sid = card.getAttribute('data-session');
          if (seen[sid]) return;
          seen[sid] = true;
          const m = mets[sid] || {};
          const bundle = ((card.querySelector('.monitor-head b') || {}).textContent) || sid;
          rows.push([bundle, new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            m.n_prompt_tokens_total || 0, m.n_predicted_tokens_total || 0,
            (m.prompt_per_second || 0).toFixed(1), (m.predicted_per_second || 0).toFixed(1),
            m.slots_processing || 0,
            m.kv_cache_usage_ratio ? (m.kv_cache_usage_ratio * 100).toFixed(0) + '%' : '0%']);
        });
      });
      rows.push([], ['请求历史', '时间', '输入tok', '输出tok', '输出速率tok/s', '总耗时ms', 'draft']);
      Object.keys(window.__reqHistory || {}).forEach(function (sid) {
        (window.__reqHistory[sid] || []).forEach(function (r) {
          rows.push([sid, r.time, r.prompt_tokens, r.eval_tokens,
            (r.eval_ps || 0).toFixed(1), r.total_ms || 0,
            r.draft_total ? (r.draft_accepted + '/' + r.draft_total) : '']);
        });
      });
      const csv = rows.map(function (r) {
        return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
      }).join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'monitor_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };
  window.Monitor = Monitor;

  window.openInstanceUI = function (sessionId) {
    getRunning().then(function (running) {
      if (!running.length) { alert('没有运行中的实例'); return; }
      const target = sessionId ? running.find(function (s) { return s.id === sessionId; }) : null;
      const pick = target || running[0];
      window.open('http://127.0.0.1:' + pick.port, '_blank');
    });
  };

  function reqRow(req) {
    const draft = req.draft_total ? ' · 🎯 ' + req.draft_accepted + '/' + req.draft_total : '';
    return '<div class="req-row"><span class="req-time">' + (req.time || '--') + '</span>' +
      ' ⬇' + (req.prompt_tokens || 0) + ' ⬆' + (req.eval_tokens || 0) +
      ' · ' + ((req.eval_ps || 0).toFixed ? (req.eval_ps || 0).toFixed(1) : (req.eval_ps || 0)) + ' tok/s' +
      ' · ' + Math.round(req.total_ms || 0) + 'ms' + draft + '</div>';
  }

  // ── API 调试面板 ──────────────────────
  let dbgAbort = null;
  let dbgHistory = [];

  function openDebugModal() {
    $('debug-modal').hidden = false;
    renderDebugSessions();
    renderMsgSample();
    renderHistory();
  }

  function renderDebugSessions() {
    api(API.sessions).then(function (list) {
      const sel = $('dbg-session');
      const active = list.filter(s => s.status === 'running' || s.status === 'starting');
      const prev = sel.value;
      sel.innerHTML = '';
      if (!active.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '（无运行实例）';
        sel.appendChild(o);
      } else {
        active.forEach(function (s) {
          const b = bundles.find(x => x.id === s.bundle_id);
          const o = document.createElement('option');
          o.value = s.id;
          o.textContent = (b ? b.name : s.bundle_id) + ' (:' + s.port + ')';
          sel.appendChild(o);
        });
        if (prev && active.some(s => s.id === prev)) sel.value = prev;
      }
    });
  }

  function renderMsgSample() {
    const box = $('dbg-messages');
    if (box.children.length) return;
    const sys = addMsgRow();
    sys.querySelector('.msg-role').value = 'system';
    sys.querySelector('.msg-content').value = '你是一个乐于助人的本地 AI 助手。';
    addMsgRow().querySelector('.msg-content').value = '你好，请介绍一下你自己';
  }

  function addMsgRow() {
    const box = $('dbg-messages');
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML = `
      <select class="msg-role">
        <option>user</option><option>assistant</option><option>system</option>
      </select>
      <textarea class="msg-content" rows="1" placeholder="消息内容…"></textarea>
      <button class="btn small msg-del" title="删除">✕</button>`;
    row.querySelector('.msg-del').addEventListener('click', function () {
      row.remove();
    });
    box.appendChild(row);
    return row;
  }

  function switchDebugTab(tpl) {
    document.querySelectorAll('.dbg-tabs .chip').forEach(function (c) {
      c.classList.toggle('active', c.dataset.tpl === tpl);
    });
    $('dbg-chat').hidden = tpl !== 'chat';
    $('dbg-completions').hidden = tpl !== 'completions';
    $('dbg-embeddings').hidden = tpl !== 'embeddings';
    clearDebugOutput();
  }

  function activeTemplate() {
    const chip = document.querySelector('.dbg-tabs .chip.active');
    return chip ? chip.dataset.tpl : 'chat';
  }

  function buildDebugBody(tpl) {
    if (tpl === 'chat') {
      const messages = [];
      document.querySelectorAll('#dbg-messages .msg-row').forEach(function (row) {
        const content = row.querySelector('.msg-content').value.trim();
        if (!content) return;
        messages.push({ role: row.querySelector('.msg-role').value, content: content });
      });
      if (!messages.length) { alert('请至少输入一条消息'); return null; }
      return {
        path: '/v1/chat/completions',
        body: {
          model: 'local',
          messages: messages,
          stream: true,
          temperature: parseFloat($('dbg-temperature').value) || 0.8,
          max_tokens: parseInt($('dbg-max_tokens').value, 10) || 256
        }
      };
    }
    if (tpl === 'completions') {
      const prompt = $('dbg-prompt').value.trim();
      if (!prompt) { alert('请输入提示词'); return null; }
      return {
        path: '/v1/completions',
        body: { model: 'local', prompt: prompt, stream: true, temperature: parseFloat($('dbg-c-temperature').value) || 0.8 }
      };
    }
    const input = $('dbg-emb-input').value.trim();
    if (!input) { alert('请输入内容'); return null; }
    return { path: '/v1/embeddings', body: { model: 'local', input: input } };
  }

  function sendDebug() {
    const tpl = activeTemplate();
    const req = buildDebugBody(tpl);
    if (!req) return;
    const sid = $('dbg-session').value;
    if (!sid) { alert('请先在配置面板启动一个实例'); return; }

    const out = $('dbg-output');
    const stats = $('dbg-stats');
    out.textContent = '';
    out.classList.add('streaming');
    stats.textContent = '';
    $('dbg-send').disabled = true;
    $('dbg-stop').disabled = false;

    const t0 = performance.now();
    let firstTokenAt = null;
    let fullText = '';
    let timing = null;
    dbgAbort = new AbortController();

    if (tpl === 'chat') {
      fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, messages: req.body.messages, max_tokens: req.body.max_tokens || 1024 }),
        signal: dbgAbort.signal
      }).then(function (res) {
        return res.json().then(function (d) { return { ok: res.ok, d: d }; });
      }).then(function (r) {
        if (!r.ok) throw new Error(r.d.error || ('agent 失败 ' + r.status));
        const totalMs = performance.now() - t0;
        fullText = r.d.content || '';
        out.textContent = fullText;
        out.scrollTop = out.scrollHeight;
        const rounds = r.d.rounds || 1;
        stats.innerHTML = '✅ 完成 — <b>🕒 ' + totalMs.toFixed(0) + 'ms</b>（Agent 工具循环 ' + rounds + ' 轮）';
        pushDebugHistory(tpl, req, fullText || '(空响应)', totalMs);
      }).catch(function (e) {
        if (e.name === 'AbortError') stats.textContent = '⏹ 已停止';
        else stats.textContent = '❌ ' + e.message;
      }).finally(function () {
        out.classList.remove('streaming');
        $('dbg-send').disabled = false;
        $('dbg-stop').disabled = true;
      });
      return;
    }

    fetch(API.debugProxy, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid, path: req.path, body: req.body }),
      signal: dbgAbort.signal
    }).then(async function (res) {
      if (!res.ok) {
        const errText = await res.text();
        throw new Error('代理错误 ' + res.status + ': ' + errText.slice(0, 200));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch (_) { continue; }
          if (chunk.timings) timing = chunk.timings;
          let delta = null;
          if (tpl === 'chat') delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
          else if (tpl === 'completions') delta = chunk.choices && chunk.choices[0] && chunk.choices[0].text;
          if (delta) {
            if (firstTokenAt === null) firstTokenAt = performance.now();
            fullText += delta;
            out.textContent = fullText;
            out.scrollTop = out.scrollHeight;
          }
        }
      }
      const totalMs = performance.now() - t0;
      const parts = [];
      if (firstTokenAt !== null) parts.push(`⏱ 首 token ${(firstTokenAt - t0).toFixed(0)}ms`);
      parts.push(`🕒 总耗时 ${totalMs.toFixed(0)}ms`);
      if (timing && timing.predicted_per_second) parts.push(`⚡ ${timing.predicted_per_second.toFixed(1)} tok/s`);
      if (timing && timing.predicted_n) parts.push(`🧾 ${timing.predicted_n} tokens`);
      stats.innerHTML = '✅ 完成 — ' + parts.map(p => `<b>${p}</b>`).join(' | ');
      pushDebugHistory(tpl, req, fullText || '(空响应)', totalMs);
    }).catch(function (e) {
      if (e.name === 'AbortError') {
        stats.textContent = '⏹ 已停止';
      } else {
        stats.textContent = '❌ ' + e.message;
      }
    }).finally(function () {
      out.classList.remove('streaming');
      $('dbg-send').disabled = false;
      $('dbg-stop').disabled = true;
    });
  }

  function stopDebug() {
    if (dbgAbort) dbgAbort.abort();
  }

  function clearDebugOutput() {
    $('dbg-output').textContent = '';
    $('dbg-stats').textContent = '';
  }

  function pushDebugHistory(tpl, req, summary, ms) {
    dbgHistory.unshift({ tpl: tpl, req: req, summary: summary, ms: ms });
    if (dbgHistory.length > 10) dbgHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    const box = $('dbg-history');
    box.innerHTML = '';
    dbgHistory.forEach(function (h, i) {
      const div = document.createElement('div');
      div.className = 'hist-item';
      div.innerHTML = `
        <button class="btn small" data-replay="${i}">▶ 重放</button>
        <span>${esc(h.tpl)} — ${esc(h.summary.slice(0, 40))} (${h.ms.toFixed(0)}ms)</span>`;
      div.querySelector('[data-replay]').addEventListener('click', function () {
        const t = h.tpl;
        switchDebugTab(t);
        if (t === 'chat' && h.req.body && h.req.body.messages) {
          $('dbg-messages').innerHTML = '';
          h.req.body.messages.forEach(function (m) {
            const row = addMsgRow();
            row.querySelector('.msg-role').value = m.role;
            row.querySelector('.msg-content').value = m.content;
          });
          $('dbg-temperature').value = h.req.body.temperature || 0.8;
          $('dbg-max_tokens').value = h.req.body.max_tokens || 256;
        } else if (t === 'completions') {
          $('dbg-prompt').value = h.req.body.prompt || '';
        } else if (t === 'embeddings') {
          $('dbg-emb-input').value = h.req.body.input || '';
        }
        $('dbg-output').textContent = h.summary;
      });
      box.appendChild(div);
    });
  }

  // ── 使用洞察面板 ──────────────────────
  function openInsights() {
    $('insights-modal').hidden = false;
    loadInsights();
  }

  function loadInsights() {
    api(API.insights).then(function (d) {
      $('ins-total-tokens').textContent = d.total_tokens ? d.total_tokens.toLocaleString() : '0';
      $('ins-total-sessions').textContent = d.total_sessions;
      $('ins-today-sessions').textContent = d.today_sessions;
      $('ins-success-rate').textContent = Math.round((d.success_rate || 0) * 100) + '%';
      $('ins-avg-tps').textContent = (d.avg_tps || 0).toFixed(1);
      renderInsightCharts(d);
    }).catch(function (e) { alert('洞察加载失败: ' + e.message); });
  }

  function renderInsightCharts(d) {
    if (typeof echarts === 'undefined') return;
    const base = {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 16, top: 24, bottom: 28 },
      textStyle: { color: '#8b96a8' }
    };
    renderChart('chart-tokens', Object.assign({}, base, {
      xAxis: { type: 'category', data: d.models.map(m => shortName(m.name)), axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.models.map(m => m.tokens), itemStyle: { color: '#4f8cff' } }]
    }));
    renderChart('chart-days', Object.assign({}, base, {
      xAxis: { type: 'category', data: d.days.map(x => x.date.slice(5)) },
      yAxis: { type: 'value' },
      series: [{
        type: 'line', smooth: true, data: d.days.map(x => x.tokens),
        lineStyle: { color: '#7c3aed', width: 2 }, areaStyle: { color: 'rgba(124,58,237,.12)' }
      }]
    }));
    const sorted = d.models.slice().sort((a, b) => b.sessions - a.sessions);
    renderChart('chart-heat', Object.assign({}, base, {
      grid: { left: 120, right: 16, top: 16, bottom: 24 },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: sorted.map(m => shortName(m.name)) },
      series: [{ type: 'bar', data: sorted.map(m => m.sessions), itemStyle: { color: '#d29922' } }]
    }));
    renderChart('chart-tps', Object.assign({}, base, {
      xAxis: { type: 'category', data: d.models.map(m => shortName(m.name)), axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: { type: 'value', name: 'tok/s' },
      series: [{ type: 'bar', data: d.models.map(m => +m.avg_tps.toFixed(1)), itemStyle: { color: '#3fb950' } }]
    }));
  }

  function renderChart(id, option) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!el.__chart) el.__chart = echarts.init(el, null, { renderer: 'canvas' });
    el.__chart.setOption(option, true);
  }

  function shortName(name) {
    const s = String(name || '');
    return s.length > 16 ? s.slice(0, 15) + '…' : s;
  }

  // ── MCP 服务器管理 ────────────────────
  function openMCPModal() {
    $('mcp-modal').hidden = false;
    loadMCP();
    loadMCPTemplates();
    checkMCPEnv();
  }

  function loadMCP() {
    const box = $('mcp-list');
    box.innerHTML = '<div class="empty-hint">加载中…</div>';
    api(API.mcpStatus).catch(function () { return []; }).then(function (statusList) {
      const byId = {};
      (statusList || []).forEach(function (st) { byId[st.id] = st; });
      api(API.mcpList).then(function (list) {
        renderMCPList(list, byId);
      }).catch(function (e) { box.innerHTML = '<div class="audit-item error">🔴 ' + esc(e.message) + '</div>'; });
    });
  }

  function renderMCPList(list, byId) {
    const box = $('mcp-list');
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint">尚未注册任何 MCP 服务器。可从上方模板一键添加，或手动注册。</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (s) {
      const st = byId[s.id] || {};
      const missingEnv = Object.keys(s.env || {}).filter(function (k) { return (s.env[k] || '').trim() === ''; });
      const dot = s.enabled
        ? (st.healthy === false ? '<span class="mcp-dot bad" title="命令不在 PATH，可能无法启动"></span>' : '<span class="mcp-dot ok" title="命令可执行"></span>')
        : '<span class="mcp-dot off" title="已停用"></span>';
      const envWarn = missingEnv.length
        ? '<span class="mcp-dot warn" title="缺少环境变量: ' + esc(missingEnv.join(', ')) + '（工具可能无法正常调用）">⚠️</span>'
        : '';
      const div = document.createElement('div');
      div.className = 'scan-item';
      div.innerHTML =
        '<div>' +
        '<div class="name">' + dot + ' ' + envWarn + ' ' + esc(s.name) + (s.enabled ? '' : ' (停用)') + '</div>' +
        '<div class="meta">命令: ' + esc(s.command) + ' ' + esc((s.args || []).join(' ')) + '</div>' +
        (missingEnv.length ? '<div class="meta" style="color:#f0a45e">⚠️ 缺少环境变量: ' + esc(missingEnv.join(', ')) + '（需在添加时填写，否则工具调用会失败）</div>' : '') +
        '<div class="actions" style="margin-top:6px;display:flex;gap:6px">' +
        '<button class="btn small" data-test="' + esc(s.id) + '">🧪 测试</button>' +
        '<button class="btn small" data-bind="' + esc(s.id) + '">🔗 绑定模型</button>' +
        '<button class="btn small" data-del="' + esc(s.id) + '">🗑 删除</button>' +
        '<span class="mcp-test-result" data-res="' + esc(s.id) + '"></span>' +
        '</div></div>';
      div.querySelector('[data-test]').addEventListener('click', function () {
        testMCP(s, div.querySelector('[data-res]'));
      });
      div.querySelector('[data-bind]').addEventListener('click', function () {
        bindMCPServer(s, div);
      });
      div.querySelector('[data-del]').addEventListener('click', function () {
        if (!confirm('删除 MCP 服务器 "' + s.name + '"？')) return;
        api('/api/mcp/' + s.id, { method: 'DELETE' }).then(function () { loadMCP(); loadMCPTemplates(); });
      });
      box.appendChild(div);
    });
  }

  function testMCP(s, resEl) {
    if (!resEl) return;
    resEl.textContent = '⏳ 测试中…';
    api(API.mcpTest, { method: 'POST', body: JSON.stringify({ command: s.command, args: s.args || [], env: s.env || {} }) })
      .then(function (r) {
        if (r.ok) {
          const tools = (r.tools || []).slice(0, 12).join('、');
          resEl.textContent = '✅ ' + r.count + ' 个工具' + (tools ? '：' + tools : '');
        } else {
          resEl.textContent = '❌ ' + (r.message || '失败');
        }
        resEl.title = r.message || '';
        resEl.className = 'mcp-test-result ' + (r.ok ? 'ok' : 'err');
      })
      .catch(function (e) { resEl.textContent = '❌ ' + e.message; resEl.className = 'mcp-test-result err'; });
  }

  function bindMCPServer(s, row) {
    let old = row.querySelector('.mcp-bind');
    if (old) { old.remove(); return; }
    const panel = document.createElement('div');
    panel.className = 'mcp-bind';
    const rows = bundles.map(function (b) {
      const checked = (b.mcp_servers || []).indexOf(s.name) >= 0 ? 'checked' : '';
      return '<label class="chk mcp-bind-row"><input type="checkbox" data-bid="' + esc(b.id) + '" ' + checked + '> ' + esc(b.name) + '</label>';
    }).join('') || '<div class="empty-hint">模型库为空。</div>';
    panel.innerHTML = '<div class="mcp-bind-title">勾选要使用「' + esc(s.name) + '」的模型：</div>' +
      '<div class="mcp-bind-list">' + rows + '</div>' +
      '<div class="actions" style="display:flex;gap:6px;margin-top:6px">' +
      '<button class="btn primary" data-bind-ok>💾 保存绑定</button>' +
      '<button class="btn" data-bind-cancel>取消</button></div>';
    panel.querySelector('[data-bind-cancel]').addEventListener('click', function () { panel.remove(); });
    panel.querySelector('[data-bind-ok]').addEventListener('click', function () {
      const checked = {};
      panel.querySelectorAll('[data-bid]').forEach(function (cb) { checked[cb.dataset.bid] = cb.checked; });
      const proms = [];
      let changed = 0;
      bundles.forEach(function (b) {
        const cur = (b.mcp_servers || []).slice();
        const idx = cur.indexOf(s.name);
        const has = idx >= 0;
        const want = !!checked[b.id];
        if (has === want) return;
        if (want) cur.push(s.name); else cur.splice(idx, 1);
        proms.push(api('/api/bundles/' + b.id + '/mcpservers', { method: 'PUT', body: JSON.stringify({ servers: cur }) })
          .then(function () { b.mcp_servers = cur; changed++; }));
      });
      Promise.all(proms).then(function () {
        panel.remove();
        flashBtn(row.querySelector('[data-bind]'), '✓ 已保存 ' + changed + ' 个');
        if (changed > 0) {
          refreshBundles();
        }
      }).catch(function (e) { alert('保存失败: ' + e.message); });
    });
    row.appendChild(panel);
  }

  function addMCP() {
    const name = $('mcp-name').value.trim();
    const command = $('mcp-command').value.trim();
    const argsStr = $('mcp-args').value.trim();
    if (!name || !command) { alert('名称与命令必填'); return; }
    const args = argsStr ? argsStr.split(/\s+/) : [];
    api(API.mcpAdd, { method: 'POST', body: JSON.stringify({ name: name, command: command, args: args, enabled: true }) })
      .then(function () {
        $('mcp-name').value = ''; $('mcp-command').value = ''; $('mcp-args').value = '';
        loadMCP();
      })
      .catch(function (e) { alert('注册失败: ' + e.message); });
  }

  function loadMCPTemplates() {
    Promise.all([
      api(API.mcpTemplates).catch(function () { return []; }),
      api(API.mcpList).catch(function () { return []; })
    ]).then(function (r) {
      renderMCPTemplates(r[0] || [], r[1] || []);
    });
  }

  function renderMCPTemplates(templates, registered) {
    const container = $('mcp-template-list');
    if (!container) return;
    if (!templates.length) { container.innerHTML = '<div class="empty-hint">暂无模板。</div>'; return; }
    const usedSet = {};
    (registered || []).forEach(function (s) { usedSet[s.name] = true; });
    const isUsed = function (tplId) {
      return !!(usedSet[tplId] || Object.keys(usedSet).some(function (n) { return n.indexOf(tplId + '-') === 0; }));
    };
    container.innerHTML = '';
    const groups = {};
    templates.forEach(function (t) {
      (groups[t.category || '其他'] = groups[t.category || '其他'] || []).push(t);
    });
    Object.keys(groups).forEach(function (cat) {
      const catEl = document.createElement('div');
      catEl.className = 'mcp-tpl-cat';
      catEl.innerHTML = '<div class="mcp-tpl-cat-name">' + esc(cat) + '</div><div class="mcp-tpl-grid"></div>';
      const grid = catEl.querySelector('.mcp-tpl-grid');
      groups[cat].sort(function (a, b) { return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0); })
        .forEach(function (tpl) {
          const used = isUsed(tpl.id);
          const card = document.createElement('div');
          card.className = 'mcp-template-card' + (tpl.recommended ? ' recommended' : '') + (used ? ' used' : '');
          card.innerHTML =
            '<div class="mcp-template-head"><span class="mcp-template-name">' + esc(tpl.name) + '</span>' +
            (tpl.recommended ? '<span class="badge">推荐</span>' : '') +
            (used ? '<span class="badge used-badge" title="该模板已添加到 MCP 服务器列表">✓ 已使用</span>' : '') + '</div>' +
            '<p class="mcp-template-desc">' + esc(tpl.description) + '</p>' +
            (tpl.hint ? '<p class="mcp-template-hint">💡 ' + esc(tpl.hint) + '</p>' : '') +
            '<button class="btn small" data-tpl="' + esc(tpl.id) + '"' + (used ? ' disabled' : '') + '>' +
            (used ? '✓ 已添加' : '＋ 使用此工具') + '</button>';
          card.querySelector('[data-tpl]').addEventListener('click', function () { onAddTemplate(tpl, card); });
          grid.appendChild(card);
        });
      container.appendChild(catEl);
    });
  }

  function onAddTemplate(tpl, card) {
    let old = card.querySelector('.tpl-config');
    if (old) { old.remove(); return; }
    const cfg = document.createElement('div');
    cfg.className = 'tpl-config';
    let html = '';
    if (tpl.requires_path) {
      html += '<div class="field"><label>文件夹/文件路径</label><input type="text" class="tpl-path" placeholder="C:/Users/..."></div>';
    }
    if (tpl.requires_text) {
      html += '<div class="field"><label>' + esc(tpl.requires_text.label || '配置') + '</label><input type="text" class="tpl-text" placeholder="' + esc(tpl.requires_text.placeholder || '') + '"></div>';
    }
    (tpl.requires_env || []).forEach(function (envName) {
      html += '<div class="field"><label>环境变量 ' + esc(envName) + '</label><input type="password" class="tpl-env" data-env="' + esc(envName) + '" placeholder="' + esc(envName) + '"></div>';
    });
    html += '<div class="actions" style="display:flex;gap:6px;margin-top:4px">' +
      '<button class="btn primary" data-tpl-ok>✅ 确认添加</button>' +
      '<button class="btn" data-tpl-cancel>取消</button></div>';
    cfg.innerHTML = html;
    cfg.querySelector('[data-tpl-cancel]').addEventListener('click', function () { cfg.remove(); });
    cfg.querySelector('[data-tpl-ok]').addEventListener('click', function () {
      let args = (tpl.args || []).slice();
      const env = {};
      const path = cfg.querySelector('.tpl-path');
      if (path && !path.value.trim()) { alert('请填写路径'); return; }
      if (path) args = args.map(function (a) { return a.replace(/{path}/g, path.value.trim()); });
      const txt = cfg.querySelector('.tpl-text');
      if (txt) {
        if (!txt.value.trim()) { alert('请填写' + (tpl.requires_text ? tpl.requires_text.label : '配置')); return; }
        args = args.map(function (a) { return a.replace(/{[^}]+}/g, txt.value.trim()); });
      }
      cfg.querySelectorAll('.tpl-env').forEach(function (inp) {
        env[inp.dataset.env] = inp.value.trim();
      });
      const server = {
        name: tpl.id + '-' + Date.now().toString(36).slice(-4),
        command: tpl.command,
        args: args,
        env: env,
        enabled: true
      };
      if (server.command.indexOf('{launcher}') >= 0 || server.args.some(function (a) { return a.indexOf('{launcher}') >= 0; })) {
        api(API.system).then(function (r) {
          const lp = (r.launcher_path || '').replace(/\\/g, '/');
          if (!lp) { alert('无法获取 llama-launcher 路径'); return; }
          server.command = server.command.replace(/{launcher}/g, lp);
          server.args = server.args.map(function (a) { return a.replace(/{launcher}/g, lp); });
          doAddMCPServer(server, cfg, card);
        }).catch(function () { alert('无法获取 llama-launcher 路径'); });
      } else {
        doAddMCPServer(server, cfg, card);
      }
    });
    card.appendChild(cfg);
  }

  function doAddMCPServer(server, cfg, card) {
    api(API.mcpAdd, { method: 'POST', body: JSON.stringify(server) })
      .then(function () { cfg.remove(); loadMCP(); loadMCPTemplates(); flashBtn(card.querySelector('[data-tpl]'), '✓ 已添加'); })
      .catch(function (e) { alert('添加失败: ' + e.message); });
  }

  function checkMCPEnv() {
    api(API.mcpCheckEnv).catch(function () { return {}; }).then(function (env) {
      const hint = $('mcp-env-hint');
      if (!hint) return;
      const warnings = [];
      if (!env.npx) warnings.push('未安装 Node.js/npx（大多数模板无法使用）');
      if (!env.python && !env.uvx) warnings.push('未检测到 Python（部分模板需要）');
      if (!env.docker) warnings.push('未检测到 Docker（容器模板不可用）');
      if (warnings.length === 0) {
        hint.innerHTML = '✅ 环境检测通过！Node.js/Python/Docker 基础依赖已就绪。';
        hint.className = 'mcp-env-hint ok';
      } else {
        hint.innerHTML = '⚠️ ' + warnings.join('；') + '。';
        hint.className = 'mcp-env-hint warn';
      }
    });
  }
    // ── 全局设置面板 ──────────────────────
  let cfgHasAPIKey = false;

  function openSettings() {
    $('settings-modal').hidden = false;
    api(API.configGet).then(function (c) {
      $('set-data-dir').value = c.data_dir || '';
      $('set-binary').value = c.binary_path || '';
      $('set-retention').value = c.log_retention_days || 30;
      $('set-hf').value = c.hf_endpoint || '';
      $('set-cache-dir').value = c.cache_dir || '';
    }).catch(function (e) { alert('加载设置失败: ' + e.message); });
  }

  function saveSettings() {
    api(API.configPut, {
      method: 'PUT',
      body: JSON.stringify({
        binary_path: $('set-binary').value.trim(),
        log_retention_days: parseInt($('set-retention').value, 10) || 30,
        hf_endpoint: $('set-hf').value.trim(),
        cache_dir: $('set-cache-dir').value.trim(),
        server_api_key: '__KEEP__'
      })
    }).then(function () {
      $('settings-modal').hidden = true;
      alert('✅ 设置已保存');
    }).catch(function (e) { alert('保存失败: ' + e.message); });
  }

  // ── 🔑 全局 API Key 专属板块 ──────────
  let akAPIKeyChanged = false;
  let akTimer = null;

  function openAPIKeyModal() {
    $('apikey-modal').hidden = false;
    loadAPIKeyState();
    renderAPIKeyMonitor();
    if (akTimer) clearInterval(akTimer);
    akTimer = setInterval(akTick, 5000);
  }

  function closeAPIKeyModal() {
    $('apikey-modal').hidden = true;
    if (akTimer) { clearInterval(akTimer); akTimer = null; }
    MonChart.resetCharts();
  }

  function loadAPIKeyState() {
    api(API.configGet).then(function (c) {
      cfgHasAPIKey = !!c.has_api_key;
      akAPIKeyChanged = false;
      $('ak-api-key').value = '';
      $('ak-api-key').placeholder = cfgHasAPIKey ? '••••••••（已保存，输入新值可替换）' : '可选，AES-256 加密存储';
      $('ak-key-hint').textContent = cfgHasAPIKey
        ? '🔒 已保存加密 Key · 点 👁 查看明文（不点不会加载明文）'
        : '未配置全局 Key。可手动粘贴，或点 🎲 生成一个 256 位随机 Key 后 💾 保存。';
      $('ak-brave-key').value = '';
      $('ak-brave-key').placeholder = c.has_brave_key ? '••••••••（已保存，输入新值可替换）' : '可选，X-Subscription-Token（search.brave.com 免费申请）';
      $('ak-tavily-key').value = '';
      $('ak-tavily-key').placeholder = c.has_tavily_key ? '••••••••（已保存，输入新值可替换）' : '可选，tvly-...（tavily.com 免费申请）';
      const hint = $('ak-search-hint');
      if (c.has_brave_key || c.has_tavily_key) {
        hint.textContent = '🟢 已配置搜索 API（' + (c.has_brave_key ? 'Brave' : '') + (c.has_brave_key && c.has_tavily_key ? ' + ' : '') + (c.has_tavily_key ? 'Tavily' : '') + '），联网搜索将用 API 提供商。';
      } else {
        hint.textContent = '不配置时用内置 Bing 免费抓取（泛查询效果一般）；配置后自动切换为对应 API，结果更准。二选一即可，Brave 优先免费额度。';
      }
    }).catch(function () {
      $('ak-key-hint').textContent = '⚠️ 读取配置失败';
    });
  }

  function akToggleVisibility() {
    const input = $('ak-api-key');
    const btn = $('ak-key-toggle');
    if (input.type === 'password' && !input.value && cfgHasAPIKey) {
      api(API.configKey).then(function (r) {
        input.value = r.key || '';
        input.type = 'text'; btn.textContent = '🙈';
        $('ak-key-hint').textContent = '🔓 已回显明文（点击 💾 保存将重新加密存储）';
      }).catch(function () { flashBtn(btn, '✗'); });
      return;
    }
    if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
    else { input.type = 'password'; btn.textContent = '👁'; }
  }

  function saveAPIKey() {
    const keyVal = $('ak-api-key').value;
    let serverApiKey = '__KEEP__';
    if (akAPIKeyChanged && keyVal === '') serverApiKey = '';
    else if (akAPIKeyChanged && keyVal !== '') serverApiKey = keyVal;
    api(API.configGet).then(function (c) {
      return api(API.configPut, {
        method: 'PUT',
        body: JSON.stringify({
          binary_path: c.binary_path || '',
          log_retention_days: c.log_retention_days || 30,
          hf_endpoint: c.hf_endpoint || '',
          cache_dir: c.cache_dir || '',
          server_api_key: serverApiKey
        })
      });
    }).then(function () {
      flashBtn($('ak-key-save'), '✓ 已保存');
      loadAPIKeyState();
      autoFillGlobalKey();
    }).catch(function (e) { alert('保存失败: ' + e.message); });
  }

  // ── 🔎 搜索 API Key（Brave/Tavily）─────────
  let akBraveKeyChanged = false;
  let akTavilyKeyChanged = false;

  function akBraveToggleVisibility() {
    const input = $('ak-brave-key');
    const btn = $('ak-brave-toggle');
    if (input.type === 'password' && !input.value) {
      api(API.configSearchKeys).then(function (r) {
        input.value = r.brave || '';
        if (input.value) { input.type = 'text'; btn.textContent = '🙈'; }
        else flashBtn(btn, '无');
      }).catch(function () { flashBtn(btn, '✗'); });
      return;
    }
    if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
    else { input.type = 'password'; btn.textContent = '👁'; }
  }

  function akTavilyToggleVisibility() {
    const input = $('ak-tavily-key');
    const btn = $('ak-tavily-toggle');
    if (input.type === 'password' && !input.value) {
      api(API.configSearchKeys).then(function (r) {
        input.value = r.tavily || '';
        if (input.value) { input.type = 'text'; btn.textContent = '🙈'; }
        else flashBtn(btn, '无');
      }).catch(function () { flashBtn(btn, '✗'); });
      return;
    }
    if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
    else { input.type = 'password'; btn.textContent = '👁'; }
  }

  function saveSearchKeys() {
    const braveVal = $('ak-brave-key').value;
    const tavilyVal = $('ak-tavily-key').value;
    let brave = '__KEEP__', tavily = '__KEEP__';
    if (akBraveKeyChanged && braveVal === '') brave = '';
    else if (akBraveKeyChanged && braveVal !== '') brave = braveVal;
    if (akTavilyKeyChanged && tavilyVal === '') tavily = '';
    else if (akTavilyKeyChanged && tavilyVal !== '') tavily = tavilyVal;
    api(API.configGet).then(function (c) {
      return api(API.configPut, {
        method: 'PUT',
        body: JSON.stringify({
          binary_path: c.binary_path || '',
          log_retention_days: c.log_retention_days || 30,
          hf_endpoint: c.hf_endpoint || '',
          cache_dir: c.cache_dir || '',
          server_api_key: '__KEEP__',
          brave_api_key: brave,
          tavily_api_key: tavily
        })
      });
    }).then(function () {
      const st = $('ak-search-status');
      if (st) { st.textContent = '✅ 已保存（重启后对 agent 搜索生效）'; setTimeout(function () { st.textContent = ''; }, 4000); }
      flashBtn($('ak-search-save'), '✓');
      loadAPIKeyState();
    }).catch(function (e) { alert('保存失败: ' + e.message); });
  }

  function loadSysResource() {
    api(API.system).then(function (r) {
      renderSysResource(r.hardware || {});
    }).catch(function () {
      const el = $('ak-sys');
      if (el) el.innerHTML = '<div class="empty-hint">系统资源接口不可用。</div>';
    });
  }

  function renderSysResource(hw) {
    const el = $('ak-sys');
    if (!el) return;
    const gpuNames = (hw.gpu_models || []).join(' / ') || '—';
    const fmtGB = function (mb) { return typeof mb === 'number' ? (mb / 1024).toFixed(1) : '--'; };
    const vramTotal = hw.total_vram_mb || 0, vramFree = hw.free_vram_mb || 0;
    const vramUsed = vramTotal > 0 ? Math.max(0, vramTotal - vramFree) : 0;
    const vramPct = vramTotal > 0 ? Math.round(vramUsed / vramTotal * 100) : 0;
    const backend = hw.backend || 'cpu';
    const badge = function (s) {
      return s === 'cuda' ? '🚀 CUDA' : s === 'vulkan' ? '🎨 Vulkan' : s === 'metal' ? '🍎 Metal' : '💻 CPU';
    };
    let html = '<div class="ak-sys-grid">';
    html += `<div class="ak-sys-card"><span class="ak-sys-label">🎮 GPU</span><span class="ak-sys-val">${esc(gpuNames)}</span></div>`;
    html += `<div class="ak-sys-card"><span class="ak-sys-label">⚡ 后端</span><span class="ak-sys-val">${badge(backend)}${hw.cuda_major ? ' (CUDA ' + hw.cuda_major + ')' : ''}</span></div>`;
    html += `<div class="ak-sys-card"><span class="ak-sys-label">🧠 CPU 核心</span><span class="ak-sys-val">${hw.cpu_cores || '--'}</span></div>`;
    html += `<div class="ak-sys-card"><span class="ak-sys-label">💾 系统内存</span><span class="ak-sys-val">${fmtGB(hw.system_ram_mb)} GB</span></div>`;
    html += '</div>';
    if (vramTotal > 0) {
      html += `<div class="ak-bar-row"><span class="ak-bar-label">🖥 GPU 显存</span>
        <div class="ak-bar"><div class="ak-bar-fill" style="width:${vramPct}%"></div></div>
        <span class="ak-bar-num">${fmtGB(vramUsed)} / ${fmtGB(vramTotal)} GB (${vramPct}%)</span></div>`;
    }
    el.innerHTML = html;
  }

  function renderGlobalStats(instances) {
    const el = $('ak-stats');
    if (!el) return;
    let predTotal = 0, promptTotal = 0, reqCount = 0, maxRPS = 0;
    instances.forEach(function (it) {
      const m = it.metrics || {};
      if (typeof m.n_predicted_tokens_total === 'number') predTotal += m.n_predicted_tokens_total;
      if (typeof m.n_prompt_tokens_total === 'number') promptTotal += m.n_prompt_tokens_total;
      if (it.requests && it.requests.length) reqCount += it.requests.length;
      if (typeof m.predicted_per_second === 'number' && m.predicted_per_second > maxRPS) maxRPS = m.predicted_per_second;
    });
    const fmt = function (v) { return typeof v === 'number' ? v.toLocaleString() : '0'; };
    el.innerHTML = `<div class="ak-stat"><span class="ak-stat-v">${fmt(predTotal)}</span><span class="ak-stat-l">累计输出 tok</span></div>
      <div class="ak-stat"><span class="ak-stat-v">${fmt(promptTotal)}</span><span class="ak-stat-l">累计输入 tok</span></div>
      <div class="ak-stat"><span class="ak-stat-v">${reqCount}</span><span class="ak-stat-l">实例请求</span></div>
      <div class="ak-stat"><span class="ak-stat-v">${maxRPS.toFixed(1)}</span><span class="ak-stat-l">峰值输出 tok/s</span></div>
      <div class="ak-stat"><span class="ak-stat-v">${instances.length}</span><span class="ak-stat-l">运行实例</span></div>`;
  }

  function renderAPIKeyMonitor() {
    const body = $('apikey-monitor');
    if (!body) return;
    api('/api/monitor').then(function (r) {
      const data = r.instances || [];
      renderGlobalStats(data);
      MonChart.resetCharts();
      if (!data.length) {
        body.innerHTML = '<div class="empty-hint">暂无运行实例。启动模型后这里会实时显示输入/输出 token、速率、并发槽位与 KV 占用。</div>';
        return;
      }
      let html = '';
      data.forEach(function (it) { html += Monitor.card(it); });
      body.innerHTML = html;
      data.forEach(function (it) {
        const visible = !!body.offsetParent;
        const el = body.querySelector('.monitor-card[data-session="' + it.session_id + '"] .monitor-chart');
        if (el && visible) MonChart.ensure(it.session_id, 'apikey-monitor', el);
        MonChart.replay(it.session_id);
        const m = (window.__liveMetrics || {})[it.session_id];
        if (m) akUpdateCard(it.session_id, m);
        if (it.requests && it.requests.length) akRenderRequests(it.session_id, it.requests);
      });
      body.querySelectorAll('.mon-big').forEach(function (btn) {
        btn.addEventListener('click', function () { Monitor.openBig(btn.getAttribute('data-sid')); });
      });
    }).catch(function () {
      body.innerHTML = '<div class="empty-hint">监控接口不可用。</div>';
    });
  }

  function akUpdateCard(sid, m) {
    const card = document.querySelector('#apikey-monitor .monitor-card[data-session="' + sid + '"]');
    if (!card) return;
    const set = function (role, txt) {
      const e = card.querySelector('[data-role="' + role + '"]');
      if (e) e.textContent = txt;
    };
    if (typeof m.n_prompt_tokens_total === 'number') set('prompt', m.n_prompt_tokens_total.toLocaleString());
    if (typeof m.n_predicted_tokens_total === 'number') set('pred', m.n_predicted_tokens_total.toLocaleString());
    if (typeof m.prompt_per_second === 'number' && isFinite(m.prompt_per_second)) set('pps', m.prompt_per_second.toFixed(1));
    if (typeof m.predicted_per_second === 'number' && isFinite(m.predicted_per_second)) set('rps', m.predicted_per_second.toFixed(1));
    if (typeof m.slots_processing === 'number') set('slots', m.slots_processing.toLocaleString());
    if (typeof m.kv_cache_usage_ratio === 'number') set('kv', (m.kv_cache_usage_ratio * 100).toFixed(0) + '%');
    MonChart.push(sid, m);
  }

  function akRenderRequests(sid, list) {
    const box = document.querySelector('#apikey-monitor .req-history[data-sid="' + sid + '"]');
    if (box) box.innerHTML = list.slice(0, 10).map(reqRow).join('');
  }

  function akTick() {
    loadSysResource();
    api('/api/monitor').then(function (r) {
      const data = r.instances || [];
      renderGlobalStats(data);
      const body = $('apikey-monitor');
      const needRebuild = body && data.length && !body.querySelector('.monitor-card');
      if (needRebuild) { renderAPIKeyMonitor(); return; }
      data.forEach(function (it) {
        const m = (window.__liveMetrics || {})[it.session_id] || it.metrics;
        if (m) akUpdateCard(it.session_id, m);
      });
    }).catch(function () { /* 保持上次数据 */ });
  }

  // ── 文件/目录浏览器 ───────────────────
  let fsMode = 'dir';
  let fsTargetId = 'scan-dir';
  let fsCurrent = { path: '', parent: '', is_root: true };

  function openFSBrowser(mode, targetId) {
    fsMode = mode;
    fsTargetId = targetId || 'scan-dir';
    $('fs-title').textContent = mode === 'dir' ? '📂 选择目录' : '📂 选择 GGUF 模型文件';
    $('fs-modal').hidden = false;
    loadFS('');
  }

  function loadFS(path) {
    $('fs-list').innerHTML = '<div class="empty-hint">加载中…</div>';
    $('fs-info').textContent = '';
    api(API.fsList + '?path=' + encodeURIComponent(path || ''))
      .then(function (res) {
        fsCurrent = res;
        $('fs-path').value = res.path || (res.is_root ? '' : '');
        renderFS(res);
      })
      .catch(function (e) {
        $('fs-list').innerHTML = `<div class="audit-item error">🔴 ${esc(e.message)}</div>`;
      });
  }

  function renderFS(res) {
    const box = $('fs-list');
    box.innerHTML = '';
    $('fs-up').disabled = !res.parent;
    $('fs-select').hidden = !(fsMode === 'dir' && !res.is_root);

    if (res.is_root) {
      box.appendChild(fsSep('根目录'));
    } else if (res.parent) {
      const up = fsRow('..', '⬆ 上级目录', 'dir', true);
      up.addEventListener('click', function () { loadFS(res.parent); });
      box.appendChild(up);
      box.appendChild(fsSep(res.path));
    }
    res.dirs.forEach(function (d) {
      const row = fsRow('📁 ' + d.name, d.path, 'dir', false);
      row.addEventListener('click', function () { loadFS(d.path); });
      box.appendChild(row);
    });
    if (!(res.dirs || []).length) {
      box.appendChild(fsInfo('该目录没有子文件夹'));
    }
  }

  function fsRow(name, right, cls, isUp) {
    const row = document.createElement('div');
    row.className = 'fs-row ' + cls;
    row.innerHTML = `<span class="fs-name">${esc(name)}</span><span class="fs-size">${esc(right)}</span>`;
    return row;
  }
  function fsSep(text) {
    const d = document.createElement('div');
    d.className = 'fs-sep';
    d.textContent = text;
    return d;
  }
  function fsInfo(text) {
    const d = document.createElement('div');
    d.className = 'empty-hint';
    d.textContent = text;
    return d;
  }

  function selectFSDir() {
    const target = document.getElementById(fsTargetId);
    if (target) {
      let p = fsCurrent.path || '';
      if (fsTargetId === 'set-cache-dir') {
        p = p.replace(/[\\/]+$/, '') + '\\llama-cache';
      }
      target.value = p;
    }
    $('fs-modal').hidden = true;
    appendLog('INFO', '📂 已选择目录: ' + fsCurrent.path);
    // 需求：从「模型库 → 扫描 → 浏览」进入的选择，选完目录后自动开始扫描，无需再点「🔍 扫描」
    if (fsTargetId === 'scan-dir') { scanDir(); }
  }

  // ── 批量测试 ───────────────────────────
  function openTestModal() {
    document.getElementById('test-modal').hidden = false;
    TestStore.reset(null);
    renderTestModelList();
    renderSweepModel();
    renderSweepParams();
    document.getElementById('test-result').innerHTML = '';
    document.getElementById('sweep-result').innerHTML = '';
    document.getElementById('test-summary').textContent = '';
    document.querySelectorAll('.sweep-modebar .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.smode === 'exhaustive');
    });
    TestStore.sweepMode = 'exhaustive';
    document.getElementById('test-start').textContent = '▶ 开始测试';
    if (window.__testChart) { window.__testChart.dispose(); window.__testChart = null; }
    if (window.__sweepChart) { window.__sweepChart.dispose(); window.__sweepChart = null; }
    document.getElementById('test-chart').style.display = 'none';
    document.getElementById('sweep-chart').hidden = true;
    document.getElementById('sweep-radar-wrap').hidden = true;
    switchTestTab('batch');
    renderTestHistory();
  }

  function switchTestTab(name) {
    document.querySelectorAll('#test-tabs .tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    hideStage();
    document.getElementById('tab-batch').hidden = name !== 'batch';
    document.getElementById('tab-sweep').hidden = name !== 'sweep';
    document.getElementById('tab-history').hidden = name !== 'history';
    const isSweep = name === 'sweep';
    document.getElementById('test-summary').textContent = '';
    resetTestProgress();
    document.getElementById('savecfg-row').hidden = true;
    document.getElementById('test-savecfg').hidden = !TestStore.lastBest;
    document.getElementById('test-start').disabled = false;
    document.getElementById('test-start').textContent = isSweep ? '▶ 开始扫描' : '▶ 开始测试';
    document.getElementById('test-cancel').hidden = !TestStore.running;
    if (name === 'history') {
      renderTestHistory();
      return;
    }
    if (isSweep) {
      renderSweepParams();
      document.querySelectorAll('.sweep-modebar .chip').forEach(x => {
        x.classList.toggle('active', x.dataset.smode === TestStore.sweepMode);
      });
      document.getElementById('btn-sweep-fillall').hidden = TestStore.sweepMode !== 'greedy';
      document.getElementById('test-start').textContent = TestStore.sweepMode === 'greedy' ? '▶ 开始寻优' : '▶ 开始扫描';
      updateSweepEstimate();
    } else {
      renderTestResult();
    }
  }

  function renderTestModelList() {
    const box = $('test-models');
    box.innerHTML = '';
    if (!bundles.length) { box.innerHTML = '<div class="empty-hint">模型库为空。</div>'; return; }
    bundles.forEach(function (b) {
      const div = document.createElement('div');
      div.className = 'test-model-row';
      div.innerHTML = `<input type="checkbox" class="tm" data-id="${esc(b.id)}" checked><span title="${esc(b.base_model && b.base_model.path || '')}">${esc(b.name)}</span>`;
      box.appendChild(div);
    });
    updateTestModelCount();
  }

  function selectAllTestModels() {
    document.querySelectorAll('#test-models .tm').forEach(function (c) { c.checked = true; });
    updateTestModelCount();
  }

  function clearTestModels() {
    document.querySelectorAll('#test-models .tm').forEach(function (c) { c.checked = false; });
    updateTestModelCount();
  }

  function updateTestModelCount() {
    const total = document.querySelectorAll('#test-models .tm').length;
    const sel = document.querySelectorAll('#test-models .tm:checked').length;
    const el = $('test-model-count');
    if (el) el.textContent = `已选 ${sel}/${total} 个模型`;
  }

  function startTest() {
    if (TestStore.running) return;
    const ids = [...document.querySelectorAll('#test-models .tm:checked')].map(c => c.dataset.id);
    if (!ids.length) { showToast('请至少勾选一个模型', 'err'); return; }
    
    TestStore.reset('batch');
    TestStore.batchItems = ids.map(id => ({ bundle_id: id, name: '排队中…', status: 'pending' }));
    TestStore.items = TestStore.batchItems;
    renderTestResult();
    document.getElementById('test-start').disabled = true;
    document.getElementById('test-start').textContent = '⏳ 测试中…';
    document.getElementById('test-summary').textContent = `共 ${ids.length} 个模型，正在逐个测试…`;
    setTestProgress(0, ids.length, `0 / ${ids.length}`);

    const tp = {};
    ['ctx_size', 'n_gpu_layers', 'threads', 'batch_size', 'temperature'].forEach(k => {
      const el = document.getElementById('tp-' + k);
      if (!el) return;
      const v = el.value.trim();
      if (v === '') return;
      tp[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
    });

    api(API.testBatch, {
      method: 'POST',
      body: JSON.stringify({
        bundle_ids: ids,
        prompt: document.getElementById('test-prompt').value.trim(),
        max_tokens: parseInt(document.getElementById('test-max-tokens').value, 10) || 16,
        params: tp
      })
    }).then(r => {
      if (r && r.job_id) {
        TestStore.setRunning(r.job_id, ids.length);
      }
    }).catch(e => {
      showToast('❌ 测试启动失败：' + e.message, 'err');
      TestStore.stopRunning();
    });
  }

  function updateTestItem(msg) {
    if (msg.stage && msg.status === undefined) {
      setStage(msg.stage);
      return;
    }
    const idx = TestStore.batchItems.findIndex(it => it.bundle_id === msg.bundle_id);
    if (idx < 0) return;
    const it = TestStore.batchItems[idx];
    if (msg.name) it.name = msg.name;
    if (msg.status) it.status = msg.status;
    if (msg.load_ms !== undefined) it.load_ms = msg.load_ms;
    if (msg.tps !== undefined) it.tps = msg.tps;
    if (msg.tokens !== undefined) it.tokens = msg.tokens;
    if (msg.error !== undefined) it.error = msg.error;
    if (msg.vram_gb !== undefined) it.vram_gb = msg.vram_gb;
    if (msg.audit !== undefined) it.audit = msg.audit;
    renderTestResult();

    if (msg.type === 'test_done') {
      const results = msg.results || [];
      TestStore.finish(results, !!msg.cancelled);
    } else {
      const ok = TestStore.batchItems.filter(i => i.status === 'ok').length;
      const fail = TestStore.batchItems.filter(i => i.status === 'fail').length;
      const done = ok + fail;
      document.getElementById('test-summary').textContent = `⏳ 测试中… 通过 ${ok} / 失败 ${fail} / 共 ${TestStore.batchItems.length}`;
      setTestProgress(done, TestStore.batchItems.length, `${done} / ${TestStore.batchItems.length}`);
    }
  }

  // ── 参数扫描 ──────────────────────────
  const SWEEP_PARAMS = [
    { key: 'n_gpu_layers', label: 'GPU 层数', type: 'int', hint: '0=纯CPU；总层数=全部上GPU', def: '0, 16, 33', ph: '如 0, 16, 33',
      presets: [['-1,0,8,16,24,32,33,40,99', '全覆盖'], ['0,16,33', '小→中→全量'], ['0,33', '纯CPU vs 全量'], ['16,32,33', '逐档上量'], ['0', '仅纯CPU'], ['33', '仅全量上GPU']] },
    { key: 'ctx_size', label: '上下文长度', type: 'int', hint: '越大越慢、越占显存', def: '', ph: '如 512,1024,2048 或更大',
      presets: [['512,1024,2048,4096,8192,16384,32768,65536,131072', '全覆盖'], ['512,1024,2048', '短/中/长'], ['1024,2048,4096', '标准三档'], ['2048,4096,8192', '偏长'], ['4096,8192,16384', '大上下文'], ['8192,16384,32768', '超大'], ['16384,32768,65536', '极限'], ['32768', '固定32K'], ['65536', '固定64K'], ['131072', '固定128K']] },
    { key: 'threads', label: '线程数', type: 'int', hint: '0=自动', def: '', ph: '如 0, 8, 16',
      presets: [['0,4,8,12,16,24,32', '全覆盖'], ['0,8,16', '自动/中/高'], ['4,8,12,16', '逐档'], ['0', '固定自动'], ['8', '固定8'], ['16', '固定16'], ['32', '固定32']] },
    { key: 'batch_size', label: '批大小', type: 'int', hint: '影响预填充速度', def: '', ph: '如 128, 256, 512',
      presets: [['128,256,512,1024,2048,4096,8192', '全覆盖'], ['128,256,512', '小/中/大'], ['256,512,1024', '中/大/超大'], ['512,1024,2048', '标准三档'], ['1024,2048,4096', '大三档'], ['2048,4096,8192', '极限'], ['512', '固定512'], ['2048', '固定2048']] },
    { key: 'ubatch_size', label: '微批大小', type: 'int', hint: '预填充实际执行批次', def: '', ph: '如 64, 128, 256',
      presets: [['64,128,256,512,1024', '全覆盖'], ['64,128,256', '小/中/大'], ['128,256', '两档'], ['256,512', '中/大'], ['512', '固定512']] },
    { key: 'cache_type_k', label: 'K 缓存类型', type: 'enum', hint: '量化缓存省显存（需 Flash 注意力）', def: '', ph: '如 f16, q8_0',
      presets: [['f32,f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1', '全覆盖'], ['f16,q8_0', 'f16 vs 量化'], ['f16,q8_0,q4_0', '三档'], ['q8_0', '固定q8_0'], ['f16', '固定f16'], ['q4_0', '固定q4_0'], ['q4_1', '固定q4_1']] },
    { key: 'cache_type_v', label: 'V 缓存类型', type: 'enum', hint: '同 K 缓存', def: '', ph: '如 f16, q8_0',
      presets: [['f32,f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1', '全覆盖'], ['f16,q8_0', 'f16 vs 量化'], ['f16,q8_0,q4_0', '三档'], ['q8_0', '固定q8_0'], ['f16', '固定f16'], ['q4_0', '固定q4_0'], ['q4_1', '固定q4_1']] },
    { key: 'flash_attn', label: 'Flash 注意力', type: 'enum', hint: '量化 KV 需开 FA', def: '', ph: 'on / off',
      presets: [['on,off,auto', '全覆盖'], ['on,off', '开 vs 关'], ['on', '固定开'], ['off', '固定关']] },
    { key: 'rope_scaling', label: 'RoPE 缩放', type: 'enum', hint: '留空=不设置', def: '', ph: 'linear / yarn',
      presets: [['none,linear,yarn', '全覆盖'], ['linear', 'linear 线性'], ['yarn', 'yarn 长上下文'], ['none,linear,yarn', '全部对比'], ['none', '固定不缩放']] },
    { key: 'load_mode', label: '加载模式', type: 'enum', hint: 'mmap 默认快', def: '', ph: 'mmap / mlock',
      presets: [['mmap,mlock,mmap+mlock,none,dio', '全覆盖'], ['mmap,mlock', '映射 vs 锁定'], ['mmap', '固定mmap'], ['mlock', '固定mlock']] },
    { key: 'numa', label: 'NUMA', type: 'enum', hint: '多路CPU有效；留空=自动', def: '', ph: 'distribute / isolate',
      presets: [['distribute,isolate', '两种策略'], ['distribute', 'distribute'], ['isolate', 'isolate']] },
    { key: 'kv_unified', label: '统一 KV 缓冲', type: 'bool', hint: 'KV 合并为统一缓冲', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'cache_ram', label: '提示缓存内存(MiB)', type: 'int', hint: '0=禁用', def: '', ph: '如 0, 8192',
      presets: [['0,2048,4096,8192,16384,32768', '全覆盖'], ['0,8192', '禁用 vs 默认'], ['0,4096,8192', '三档'], ['4096,8192,16384', '偏大三档'], ['8192', '固定8192'], ['0', '固定禁用']] },
    { key: 'ctx_checkpoints', label: '上下文检查点', type: 'int', hint: '检查点数量', def: '', ph: '如 16, 32, 64',
      presets: [['0,8,16,32,64', '全覆盖'], ['16,32,64', '三档'], ['32', '固定32'], ['0,32', '禁用 vs 默认'], ['0', '固定禁用']] },
    { key: 'checkpoint_min_step', label: '检查点最小间隔', type: 'int', hint: '间隔越大越省', def: '', ph: '如 4096, 8192',
      presets: [['2048,4096,8192,16384', '全覆盖'], ['4096,8192,16384', '三档'], ['2048,4096,8192', '更密三档'], ['8192', '固定8192']] },
    { key: 'cpu_moe', label: 'MoE 专家驻留 CPU', type: 'bool', hint: 'MoE 专家留在 CPU', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'parallel', label: '并行槽位', type: 'int', hint: '并发请求槽位数', def: '', ph: '如 1, 4, 8',
      presets: [['1,2,4,8', '全覆盖'], ['1,4,8', '低/中/高'], ['4,8', '两档'], ['1', '固定单槽'], ['4', '固定4']] },
    { key: 'main_gpu', label: '主 GPU', type: 'int', hint: '主 GPU 编号（多卡）', def: '', ph: '如 0, 1',
      presets: [['0,1,2,3', '全覆盖'], ['0,1', '两卡对比'], ['0', '固定0'], ['1', '固定1']] },
    { key: 'split_mode', label: '张量拆分', type: 'enum', hint: '多卡拆分方式', def: '', ph: 'layer / row',
      presets: [['none,layer,row,tensor', '全覆盖'], ['layer,row', '层 vs 行'], ['none,row', 'none vs 行'], ['none', '固定none'], ['layer', '按层'], ['row', '按行'], ['tensor', '张量级']] },
    { key: 'tensor_split', label: '张量分配', type: 'string', hint: '各卡权重比例', def: '', ph: '如 0.5,0.5',
      presets: [['0.5,0.5', '双卡均分'], ['0.7,0.3', '偏重']] },
    { key: 'rope_scale', label: 'RoPE 缩放因子', type: 'float', hint: '上下文外推倍数', def: '', ph: '如 2, 4',
      presets: [['1,2,4,8', '全覆盖'], ['2,4', '两档'], ['2', '2倍'], ['4', '4倍']] },
    { key: 'kv_offload', label: 'KV 卸载 GPU', type: 'bool', hint: 'KV 缓存放 GPU', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'keep', label: '保留初始 token', type: 'int', hint: '长上下文复用', def: '', ph: '如 0, 48',
      presets: [['0,16,32,48,64', '全覆盖'], ['0,48', '两种'], ['0', '不保留'], ['48', '保留48']] },
    { key: 'cache_reuse', label: 'KV 复用最小块', type: 'int', hint: '块大小', def: '', ph: '如 256, 512',
      presets: [['0,256,512,1024', '全覆盖'], ['256,512', '两档'], ['0', '禁用'], ['512', '512']] },
    { key: 'cache_idle_slots', label: '缓存空闲槽位', type: 'bool', hint: '空闲槽位复用', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'context_shift', label: '上下文移位', type: 'bool', hint: '长对话移位', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'threads_batch', label: '批处理线程', type: 'int', hint: '预填充线程', def: '', ph: '如 0, 8, 16',
      presets: [['0,4,8,16,32', '全覆盖'], ['0,8,16', '三档'], ['0', '跟随'], ['8', '固定8']] },
    { key: 'n_cpu_moe', label: 'CPU 专家数', type: 'int', hint: 'MoE 留 CPU 层数', def: '', ph: '如 0, 4, 8',
      presets: [['0,4,8,16', '全覆盖'], ['0,4,8', '三档'], ['0', '不用'], ['8', '固定8']] },
    { key: 'no_mmproj_offload', label: 'mmproj 走 CPU', type: 'bool', hint: '省显存给主模型', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'mmproj_device', label: 'mmproj 设备', type: 'string', hint: '投影器设备：留空=自动，none=不卸载，或设备号如 0（v0.2.0 新增）', def: '', ph: '留空 / 0 / none',
      presets: [['0', 'GPU 0'], ['1', 'GPU 1'], ['none', '不卸载']] },
    { key: 'reasoning_effort', label: '推理努力', type: 'enum', hint: '推理模型思考强度', def: '', ph: 'low / medium / high',
      presets: [['low,medium,high', '三档'], ['medium,high', '两档'], ['low', '低'], ['high', '高']] },
    { key: 'sampler_seq', label: '简化采样序列', type: 'string', hint: '单字符采样链', def: '', ph: '如 edskypmxt',
      presets: [['edskypmxt', '默认链'], ['ekpmxt', '精简']] },
    { key: 'ignore_eos', label: '忽略 EOS', type: 'bool', hint: '不因结束符停止', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] }
  ];

  let sweepAllMode = false;

  function renderSweepModel() {
    const sel = $('sweep-model');
    sel.innerHTML = '';
    bundles.forEach(function (b) {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.name + (b.base_model && b.base_model.path ? '（' + b.base_model.path + '）' : '');
      sel.appendChild(o);
    });
  }

  function mxcOfSweepModel() {
    const sm = $('sweep-model');
    const sb = bundles.find(function (x) { return x.id === sm.value; });
    return sb ? Number(((sb.base_model || {}).metadata || {}).context_length || 0) : 0;
  }

  var PARAM_PRESETS = {
    parallel: [['-1', '自动（推荐）'], ['1', '1 单槽位'], ['2', '2 双槽位（2 并发）'], ['4', '4 四槽位'], ['8', '8 八槽位']],
    n_cpu_ffn: [['0', '0 全 GPU（推荐）'], ['8', '8 层留 CPU'], ['16', '16 层留 CPU'], ['32', '32 层留 CPU']],
    slot_prompt_similarity: [['0.10', '0.10 默认'], ['0.30', '0.30 更省显存'], ['0.50', '0.50 激进复用']],
    rope_scale: [['1.0', '1.0 原长（推荐）'], ['1.5', '1.5 中扩长'], ['2.0', '2.0 大幅扩长']],
    image_min_tokens: [['0', '0 默认'], ['256', '256'], ['512', '512']],
    image_max_tokens: [['0', '0 默认'], ['1024', '1024'], ['2048', '2048']],
    mtmd_batch_max_tokens: [['512', '512 省显存'], ['1024', '1024 默认'], ['2048', '2048 快但费显存']],
    embd_normalize: [['-1', '-1 不归一化'], ['0', '0 最大绝对值'], ['2', '2 欧氏（推荐）']],
    temperature: [['0.2', '0.2 精确（代码/翻译）'], ['0.4', '0.4 严谨'], ['0.6', '0.6 均衡'], ['0.8', '0.8 默认'], ['1.0', '1.0 创意']],
    top_p: [['0.90', '0.90 保守'], ['0.95', '0.95 默认'], ['1.00', '1.00 关闭采样限制']],
    top_k: [['20', '20 保守'], ['40', '40 默认'], ['60', '60 更随机'], ['100', '100 放开']],
    min_p: [['0.05', '0.05 默认'], ['0.10', '0.10 更严格'], ['0.20', '0.20 严格过滤']],
    repeat_penalty: [['1.00', '1.0 关闭'], ['1.10', '1.1 温和防复读'], ['1.30', '1.3 推荐写作'], ['1.50', '1.5 强防复读']],
    dry_multiplier: [['0', '0 禁用'], ['0.80', '0.8 温和'], ['1.20', '1.2 强（防复读）']],
    dry_base: [['1.75', '1.75 默认'], ['2.00', '2.00 更敏感']],
    dry_allowed_length: [['2', '2 默认'], ['4', '4 放宽'], ['6', '6 更宽松']],
    dry_penalty_last_n: [['64', '64 默认'], ['-1', '-1 全上下文（开销大）'], ['128', '128']],
    xtc_probability: [['0', '0 禁用'], ['0.30', '0.3 温和'], ['0.50', '0.5 强去重']],
    xtc_threshold: [['0.10', '0.1 默认'], ['0.20', '0.2 更频繁']],
    top_nsigma: [['-1', '-1 禁用'], ['0.50', '0.5 温和'], ['1.00', '1.0 严格']],
    typical: [['1.00', '1.0 关闭'], ['0.90', '0.9 温和'], ['0.80', '0.8 严格']],
    dynatemp_range: [['0', '0 禁用'], ['0.50', '0.5 动态'], ['1.00', '1.0 大幅动态']],
    dynatemp_exp: [['1.00', '1.0 线性'], ['2.00', '2.0 更敏感']],
    mirostat_lr: [['0.10', '0.1 默认'], ['0.30', '0.3 快'], ['0.50', '0.5 快']],
    mirostat_ent: [['3.0', '3.0 严谨'], ['5.0', '5.0 默认'], ['7.0', '7.0 创意']],
    repeat_last_n: [['64', '64 默认'], ['128', '128 更稳'], ['256', '256 强防复读']],
    seed: [['-1', '-1 随机（推荐）'], ['0', '0 固定'], ['42', '42 固定']],
    spec_draft_threads_batch: [['0', '0 跟随（推荐）'], ['4', '4'], ['8', '8'], ['16', '16']],
    kv_unified_per_slot: [['0', '0 不限（推荐）'], ['8192', '8K'], ['16384', '16K'], ['32768', '32K']],
    cache_reuse: [['0', '0 默认'], ['64', '64'], ['256', '256']],
    keep: [['0', '0 默认'], ['64', '64'], ['256', '256']],
    sleep_idle_seconds: [['-1', '-1 不休眠（推荐）'], ['60', '1 分钟'], ['300', '5 分钟'], ['600', '10 分钟']],
    timeout: [['60', '60 秒'], ['300', '5 分钟'], ['3600', '3600 默认']],
    sse_ping_interval: [['-1', '-1 禁用'], ['15', '15 秒'], ['30', '30 默认'], ['60', '60 秒']],
    threads_http: [['-1', '-1 自动（推荐）'], ['1', '1'], ['2', '2'], ['4', '4']],
    prio: [['0', '0 普通'], ['1', '1'], ['2', '2 高'], ['3', '3 实时']],
    poll: [['0', '0'], ['50', '50 默认'], ['100', '100']],
    prio_batch: [['0', '0'], ['1', '1'], ['2', '2']],
    poll_batch: [['0', '0'], ['50', '50'], ['100', '100']],
    log_verbosity: [['0', '0 静默'], ['1', '1 少'], ['2', '2'], ['3', '3 默认'], ['5', '5 全量调试']]
  };

  function buildAutoPresets(p) {
    return PARAM_PRESETS[p.key] || [];
  }

  function addPresetsToAllParams() {
    if (!paramDefs) return;
    paramDefs.forEach(function (p) {
      var opts = PARAM_PRESETS[p.key];
      if (!opts || !opts.length) return;
      var el = document.getElementById('p-' + p.key);
      if (!el || el.tagName !== 'INPUT' || el.type === 'checkbox') return;
      var field = el.closest('.field');
      if (!field) return;
      if (field.querySelector('.auto-preset-row, select.preset[data-target="p-' + p.key + '"]')) return;
      var sel = document.createElement('select');
      sel.className = 'preset auto-preset';
      sel.dataset.target = 'p-' + p.key;
      sel.title = '一键填入官方推荐值';
      var html = '<option value="">▾ 推荐值</option>';
      opts.forEach(function (o) { html += '<option value="' + o[0] + '">' + o[1] + '</option>'; });
      sel.innerHTML = html;
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        el.value = sel.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        sel.value = '';
      });
      var nw = el.closest('.num-wrap');
      if (nw) {
        nw.appendChild(sel);
      } else {
        nw = document.createElement('span');
        nw.className = 'num-wrap';
        el.before(nw);
        nw.appendChild(el);
        nw.appendChild(sel);
      }
    });
  }

  function enhanceParamFields() {
    if (!window.__paramGuidance) return;
    document.querySelectorAll('.cfg-group .field').forEach(function (f) {
      var inp = f.querySelector('input[id^="p-"], select[id^="p-"]');
      if (!inp) return;
      var key = inp.id.slice(2);
      var g = window.__paramGuidance[key];
      if (!g) return;
      if (f.querySelector('.param-help-btn')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn tiny param-help-btn';
      btn.textContent = '📖';
      btn.title = '查看说明与推荐值（显示在参数区末尾的说明板）';
      btn.onclick = function () { showParamHelpDock(key, btn); };
      f.appendChild(btn);
    });
  }

  function renderParamCard(key, container) {
    const guidance = window.__paramGuidance && window.__paramGuidance[key];
    if (!guidance) {
      container.innerHTML = '<div class="empty-hint">暂无说明</div>';
      return;
    }
    const currentVal = document.getElementById('p-' + key) ? document.getElementById('p-' + key).value : '';
    const rec = guidance.recommendation || '';
    const isMatch = rec && currentVal && rec.indexOf(currentVal) >= 0;
    let html = '<div class="param-card">';
    if (guidance.description) html += '<div class="pc-desc">' + esc(guidance.description) + '</div>';
    if (rec) {
      html += '<div class="pc-rec">✅ 推荐值：<strong>' + esc(rec) + '</strong>';
      if (currentVal) {
        html += isMatch ? ' <span style="color:#4caf50">（已符合）</span>' : ' <span style="color:#ff9800">（建议调整）</span>';
      }
      html += '</div>';
    }
    if (guidance.related && guidance.related.length) {
      html += '<div class="pc-related">⚠️ 关联参数：' + guidance.related.map(function (r) {
        return '<a href="#" data-jump="p-' + r + '" class="pc-jump">' + esc(r) + '</a>';
      }).join('、') + '</div>';
    }
    if (guidance.note) html += '<div class="pc-note">💡 ' + esc(guidance.note) + '</div>';
    if (guidance.see_also) html += '<div class="pc-see">📖 更多：' + esc(guidance.see_also) + '</div>';
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.pc-jump').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        const targetId = this.dataset.jump;
        const el = document.getElementById(targetId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();
          el.style.transition = 'background 0.6s';
          el.style.background = '#ffff99';
          setTimeout(function () { el.style.background = ''; }, 1000);
        }
      });
    });
  }

  // 参数说明集中板：点参数行旁的 📖，说明/推荐统一显示在参数区末尾的说明板
  // （主配置面板用 #param-help-dock；参数扫描面板用 #sweep-help-dock）
  function showParamHelpDock(key, btn) {
    const dock = document.getElementById('param-help-dock');
    const body = document.getElementById('param-help-body');
    if (!dock || !body) return;
    dock.hidden = false;
    renderParamCard(key, body);
    document.querySelectorAll('.cfg-group .param-help-btn').forEach(function (b) { b.classList.remove('hl'); });
    if (btn) btn.classList.add('hl');
    dock.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function showSweepHelp(key, btn) {
    const dock = document.getElementById('sweep-help-dock');
    const body = document.getElementById('sweep-help-body');
    if (!dock || !body) return;
    dock.hidden = false;
    renderParamCard(key, body);
    if (btn) btn.classList.add('hl');
    dock.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // 测试参数：把主配置面板当前的 ctx / GPU 层数 / 线程 / 批大小 / 温度填入测试参数
  function syncMainToTest() {
    const map = { 'p-ctx_size': 'tp-ctx_size', 'p-n_gpu_layers': 'tp-n_gpu_layers', 'p-threads': 'tp-threads', 'p-batch_size': 'tp-batch_size', 'p-temperature': 'tp-temperature' };
    let n = 0;
    Object.keys(map).forEach(function (src) {
      const sv = document.getElementById(src);
      const tv = document.getElementById(map[src]);
      if (!sv || !tv) return;
      const v = String(sv.value == null ? '' : sv.value).trim();
      if (v === '') return;
      tv.value = v;
      n++;
    });
    const b = document.getElementById('btn-sync-main-test');
    if (b && typeof flashBtn === 'function') flashBtn(b, '✓ 已沿用');
    if (n === 0 && typeof showToast === 'function') showToast('主面板当前 ctx/GPU/线程/批/温度均为空（将用测试默认），可先在模型配置里设置', 'info');
  }

  function sweepRowHTML(p) {
    const singles = [];
    (p.presets || []).forEach(function (pr) {
      String(pr[0]).split(',').forEach(function (s) {
        s = s.trim();
        if (s && singles.indexOf(s) < 0) singles.push(s);
      });
    });
    const opts = singles.map(function (s) {
      return '<option value="' + esc(s) + '">' + esc(s) + '</option>';
    }).join('');
    const numeric = p.type === 'int' || p.type === 'float';
    const chips = (p.presets || []).map(function (pr) {
      const tip = esc(pr[1] || pr[0]);
      return '<button class="btn tiny me-chip" data-key="' + p.key + '" data-val="' + esc(pr[0]) + '" title="' + tip + ' → ' + esc(pr[0]) + '">' + esc(pr[0]) + '</button>';
    }).join('');
    return '<span class="sweep-label">' + esc(p.label) + '<i class="sweep-hint">' + esc(p.hint) + '</i></span>' +
      '<span class="sweep-mode" title=""></span>' +
      '<span class="sweep-cap" data-cap="' + p.key + '"></span>' +
      '<input type="text" id="sw-' + p.key + '" data-key="' + p.key + '" value="' + esc(p.def || '') + '" placeholder="' + esc(p.ph || '逗号分隔多个值（多值=扫描，单值=固定）') + '">' +
      '<button class="btn tiny" data-editor="' + p.key + '" title="折叠 / 展开范围生成与档位">📐</button>' +
      '<select class="preset" data-target="sw-' + p.key + '" title="一键填入常用值"><option value="">▾ 预设</option>' + opts + '</select>' +
      '<button class="btn tiny" data-help="' + p.key + '" title="参数说明">📖</button>' +
      '<button class="btn tiny" data-clear="' + p.key + '" title="清空此项">✕</button>' +
      '<div class="multi-editor" id="me-' + p.key + '">' +
      (numeric
        ? '<div class="me-range"><span>范围</span>' +
          '<input type="number" class="me-min" data-me="' + p.key + '" placeholder="min" title="最小值">' +
          '<span>~</span><input type="number" class="me-max" data-me="' + p.key + '" placeholder="max" title="最大值">' +
          '<span>步长</span><input type="number" class="me-step" data-me="' + p.key + '" placeholder="step" title="步长">' +
          '<button class="btn tiny" data-gen="' + p.key + '">生成</button></div>'
        : '') +
      (chips ? '<div class="me-presets"><span>档位</span>' + chips + '</div>' : '') +
      '</div>';
  }

  function bindSweepRow(row) {
    const inp = row.querySelector('input[data-key]');
    if (inp) inp.addEventListener('input', updateSweepEstimate);
    const clearBtn = row.querySelector('[data-clear]');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      const t = $('sw-' + clearBtn.dataset.clear);
      if (t) t.value = '';
      updateSweepEstimate();
    });
    const presetSel = row.querySelector('.preset[data-target]');
    if (presetSel) presetSel.addEventListener('change', function () {
      const target = $(presetSel.dataset.target);
      const val = presetSel.value;
      presetSel.value = '';
      if (!target || val === '') return;
      const cur = target.value.trim();
      const parts = cur ? cur.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
      if (parts.indexOf(val) >= 0) return;
      parts.push(val);
      target.value = parts.join(',');
      updateSweepEstimate();
    });
    const helpBtn = row.querySelector('[data-help]');
    if (helpBtn) {
      helpBtn.addEventListener('click', function () { showSweepHelp(helpBtn.dataset.help, helpBtn); });
    }
    const edBtn = row.querySelector('[data-editor]');
    if (edBtn) edBtn.addEventListener('click', function () {
      const panel = $('me-' + edBtn.dataset.editor);
      if (panel) panel.hidden = !panel.hidden;
    });
    const gen = row.querySelector('[data-gen]');
    if (gen) gen.addEventListener('click', function () {
      const key = gen.dataset.gen;
      const min = parseFloat((row.querySelector('.me-min') || {}).value);
      const max = parseFloat((row.querySelector('.me-max') || {}).value);
      const step = parseFloat((row.querySelector('.me-step') || {}).value);
      if (!isFinite(min) || !isFinite(max) || !isFinite(step) || step <= 0 || max < min) {
        flashBtn(gen, '请填范围');
        return;
      }
      const vals = [];
      const isInt = Number.isInteger(min) && Number.isInteger(max) && Number.isInteger(step);
      const fmt = function (v) { return isInt ? String(Math.round(v)) : String(+v.toFixed(4)); };
      for (let v = min; v <= max; v += step) vals.push(fmt(v));
      const target = $('sw-' + key);
      if (target) {
        target.value = vals.join(',');
        updateSweepEstimate();
        flashBtn(gen, '✓ ' + vals.length + ' 档');
      }
    });
    row.querySelectorAll('.me-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        const target = $('sw-' + chip.dataset.key);
        if (!target) return;
        const addVals = String(chip.dataset.val).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        const cur = target.value.trim();
        const parts = cur ? cur.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        let added = 0;
        addVals.forEach(function (v) {
          if (parts.indexOf(v) < 0) { parts.push(v); added++; }
        });
        if (!added) { flashBtn(chip, '已含'); return; }
        target.value = parts.join(',');
        flashBtn(chip, '✓ +' + added);
        updateSweepEstimate();
      });
    });
  }

  function addSweepRow(p) {
    const tier = window.__paramTiers && window.__paramTiers[p.key];
    if (tier === 'system') return;
    const box = $('sweep-params');
    const row = document.createElement('div');
    row.className = 'sweep-row';
    row.dataset.key = p.key;
    row.innerHTML = sweepRowHTML(p);
    bindSweepRow(row);
    box.appendChild(row);
    if (p.key === 'ctx_size') fillCtxPreset(row.querySelector('.preset'), mxcOfSweepModel());
    updateSweepEstimate();
  }

  function renderSweepParams() {
    const box = $('sweep-params');
    box.innerHTML = '';
    const visible = SWEEP_PARAMS.filter(function (p) {
      const tier = window.__paramTiers && window.__paramTiers[p.key];
      return tier !== 'system';
    });
    visible.forEach(function (p) { addSweepRow(p); });
    const ctxRow = box.querySelector('.preset[data-target="sw-ctx_size"]');
    if (ctxRow) fillCtxPreset(ctxRow, mxcOfSweepModel());
    applySweepGrey();
  }

  // ── 动态添加更多可扫参数 ──────────────
  function loadSweepAddParamOptions() {
    api('/api/params').then(function (res) {
      window.__sweepParams = (res && res.params) || [];
      sweepAddFilter();
    }).catch(function () { /* 忽略加载失败 */ });
  }

  function sweepAddFilter() {
    const sel = $('sweep-add-param');
    if (!sel) return;
    const used = {};
    SWEEP_PARAMS.forEach(function (p) { used[p.key] = true; });
    document.querySelectorAll('#sweep-params .sweep-row').forEach(function (r) { if (r.dataset.key) used[r.dataset.key] = true; });
    const q = ($('sweep-add-search') ? $('sweep-add-search').value : '').trim().toLowerCase();
    sel.innerHTML = '<option value="">➕ 添加更多参数…</option>';
    const groups = {};
    (window.__sweepParams || []).forEach(function (pd) {
      if (used[pd.key] || ['int', 'float', 'enum', 'bool'].indexOf(pd.kind) < 0) return;
      const tier = window.__paramTiers && window.__paramTiers[pd.key];
      if (tier === 'system') return;
      if (q && (pd.label + ' ' + pd.key).toLowerCase().indexOf(q) < 0) return;
      (groups[pd.group] = groups[pd.group] || []).push(pd);
    });
    const order = ['basic', 'perf', 'memory', 'cpu', 'sample', 'spec', 'source', 'network', 'chat', 'log'];
    order.forEach(function (g) {
      const arr = groups[g];
      if (!arr || !arr.length) return;
      const og = document.createElement('optgroup');
      og.label = GROUP_LABEL[g] || g;
      arr.forEach(function (pd) {
        const o = document.createElement('option');
        o.value = pd.key;
        o.textContent = pd.label + '（' + pd.key + '）';
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
  }

  function buildSweepChips(key, pd, type) {
    if (type === 'bool') return [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']];
    if (PARAM_PRESETS[key]) {
      const arr = PARAM_PRESETS[key];
      const chips = arr.map(function (o) { return [o[0], o[1]]; });
      if (arr.length > 1) chips.push([arr.map(function (o) { return o[0]; }).join(','), '全覆盖']);
      return chips;
    }
    if (type === 'enum' && pd && pd.default !== '' && pd.default != null) return [[String(pd.default), '默认值']];
    return [];
  }

  function showAllSweepParams() {
    const btn = $('btn-sweep-all');
    if (sweepAllMode) {
      sweepAllMode = false;
      renderSweepParams();
      loadSweepAddParamOptions();
      if (btn) {
        btn.textContent = '📂 显示全部参数';
        btn.title = '从 registry 加载全部可扫参数（按分组展示）';
        flashBtn(btn, '✓ 已恢复默认');
      }
      return;
    }
    sweepAllMode = true;
    const box = $('sweep-params');
    box.innerHTML = '';
    api('/api/params').then(function (res) {
      const list = (res && res.params) || [];
      window.__sweepParams = list;
      const groups = {};
      list.forEach(function (pd) {
        if (['int', 'float', 'enum', 'bool'].indexOf(pd.kind) < 0) return;
        const tier = window.__paramTiers && window.__paramTiers[pd.key];
        if (tier === 'system') return;
        (groups[pd.group] = groups[pd.group] || []).push(pd);
      });
      const order = ['basic', 'perf', 'memory', 'cpu', 'sample', 'spec', 'source', 'network', 'chat', 'log'];
      let added = 0;
      order.forEach(function (g) {
        const arr = groups[g];
        if (!arr || !arr.length) return;
        const head = document.createElement('div');
        head.className = 'sweep-group';
        head.textContent = GROUP_LABEL[g] || g;
        box.appendChild(head);
        arr.forEach(function (pd) {
          const type = sweepKindToType(pd.kind);
          addSweepRow({
            key: pd.key, label: pd.label || pd.key, type: type,
            hint: pd.help || '', def: '', ph: '逗号分隔多个值（多值=扫描，单值=固定）',
            presets: buildSweepChips(pd.key, pd, type)
          });
          added++;
        });
      });
      sweepAddFilter();
      if (btn) {
        btn.textContent = '🔙 恢复默认';
        btn.title = '恢复为默认展示的常用参数集';
        flashBtn(btn, '✓ 已显示 ' + added + ' 个');
      }
    }).catch(function () {
      sweepAllMode = false;
      renderSweepParams();
      if (btn) flashBtn(btn, '✗ 加载失败');
    });
  }

  function sweepKindToType(kind) {
    if (kind === 'enum') return 'enum';
    if (kind === 'bool') return 'bool';
    if (kind === 'float') return 'float';
    return 'int';
  }

  function buildPresetsFor(pd, type) {
    if (type === 'bool') return [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']];
    if (type === 'enum' && pd.default !== '' && pd.default != null) return [[String(pd.default), '默认值']];
    return [];
  }

  function onAddSweepParam() {
    const sel = $('sweep-add-param');
    const key = sel.value;
    if (!key) return;
    sel.value = '';
    if (document.getElementById('sw-' + key)) { flashSelect(sel); return; }
    const pd = (window.__sweepParams || []).find(function (x) { return x.key === key; });
    if (!pd) return;
    const type = sweepKindToType(pd.kind);
    const tier = window.__paramTiers && window.__paramTiers[key];
    if (tier === 'system') { flashSelect(sel); return; }
    addSweepRow({
      key: key, label: pd.label || key, type: type,
      hint: pd.help || '', def: '', ph: '逗号分隔多个值（多值=扫描，单值=固定）',
      presets: buildSweepChips(key, pd, type)
    });
    sweepAddFilter();
  }

  function fmtDur(secs) {
    if (secs < 60) return '约 ' + Math.max(1, Math.round(secs)) + ' 秒';
    if (secs < 3600) return '约 ' + Math.round(secs / 60) + ' 分钟';
    const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return '约 ' + h + ' 小时 ' + m + ' 分钟';
  }

  function fillAllSweepParams() {
    SWEEP_PARAMS.forEach(function (p) {
      const inp = $('sw-' + p.key);
      if (!inp) return;
      const v = p.def || (p.presets && p.presets[0] && p.presets[0][0]) || '';
      const n = String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean).length;
      inp.value = n >= 2 ? v : '';
    });
    updateSweepEstimate();
  }

  const SCENARIOS = {
    speed: {
      n_gpu_layers: '33', ctx_size: '2048,4096,8192', threads: '16,32',
      batch_size: '1024,2048', flash_attn: 'on', kv_unified: 'on', parallel: '1,4'
    },
    vram: {
      n_gpu_layers: '0,16', ctx_size: '1024,2048', cache_type_k: 'q8_0', cache_type_v: 'q8_0',
      flash_attn: 'on', kv_unified: 'on', threads: '8'
    },
    bal: {
      n_gpu_layers: '0,16,33', ctx_size: '2048,4096', threads: '8,16',
      batch_size: '512,1024,2048', flash_attn: 'on', cache_type_k: 'f16,q8_0', cache_type_v: 'f16,q8_0'
    }
  };

  function clearAllSweepParams() {
    document.querySelectorAll('#sweep-params input[data-key]').forEach(function (inp) { inp.value = ''; });
    updateSweepEstimate();
    flashBtn($('btn-sweep-clear'), '✓ 已清空');
  }

  function applyScenario(name) {
    const sc = SCENARIOS[name];
    if (!sc) return;
    document.querySelectorAll('#sweep-params input[data-key]').forEach(function (inp) {
      inp.value = sc[inp.dataset.key] || '';
    });
    updateSweepEstimate();
    const chip = document.querySelector('.scenario-bar .chip[data-scenario="' + name + '"]');
    if (chip) flashBtn(chip, '✓ 已应用');
  }

  function sweepModelMeta() {
    const sm = $('sweep-model');
    const sb = bundles.find(function (x) { return x.id === sm.value; });
    if (!sb) return { isMoe: false, hasMMProj: false };
    const m = (sb.base_model && sb.base_model.metadata) || {};
    const isMoe = !!(m.is_moe || m.expert_count || (sb.base_model && sb.base_model.is_moe));
    const hasMMProj = !!(sb.mmproj && sb.mmproj.path);
    return { isMoe: isMoe, hasMMProj: hasMMProj };
  }

  function applySweepGrey() {
    const meta = sweepModelMeta();
    const rules = {
      cpu_moe: { ok: meta.isMoe, why: '非 MoE 模型，无需专家驻留 CPU' },
      n_cpu_moe: { ok: meta.isMoe, why: '非 MoE 模型，无需 CPU 专家数' },
      no_mmproj_offload: { ok: meta.hasMMProj, why: '该模型无多模态投影（mmproj）' }
    };
    document.querySelectorAll('#sweep-params .sweep-row').forEach(function (row) {
      const key = row.dataset.key;
      const rule = rules[key];
      if (!rule) return;
      const dis = !rule.ok;
      row.classList.toggle('grey', dis);
      const inp = row.querySelector('input[data-key]');
      if (inp) inp.disabled = dis;
      const lbl = row.querySelector('.sweep-label');
      if (lbl) lbl.title = dis ? rule.why : '';
    });
  }

  function updateSweepEstimate() {
    const CAP = 512;
    const PER_COMBO_SEC = 15;
    let total = 1, tests = 0, any = false;
    const swept = [], fixed = [], untouched = [];
    document.querySelectorAll('#sweep-params input[data-key]').forEach(function (inp) {
      const vals = String(inp.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      const n = vals.length;
      const p = SWEEP_PARAMS.find(function (x) { return x.key === inp.dataset.key; });
      const lbl = p ? p.label : inp.dataset.key;
      const tag = inp.closest('.sweep-row').querySelector('.sweep-mode');
      const cap = inp.closest('.sweep-row').querySelector('.sweep-cap');
      if (n === 0) {
        if (tag) { tag.textContent = ''; tag.title = '不参与（用默认值）'; }
        if (cap) cap.textContent = '';
        untouched.push(lbl);
        return;
      }
      any = true;
      if (n > 1) {
        total *= n;
        tests += n;
        swept.push(lbl + '(' + vals.join('/') + ')');
        if (tag) { tag.textContent = '🔀'; tag.title = '扫描 ' + n + ' 档'; }
        if (cap) cap.textContent = '[' + lbl + ': ' + vals[0] + '~' + vals[n - 1] + ' (' + n + ' 档)]';
      } else {
        fixed.push(lbl + '=' + vals[0]);
        if (tag) { tag.textContent = '📌'; tag.title = '固定 ' + vals[0] + '，用于每个组合'; }
        if (cap) cap.textContent = '[' + lbl + ': 固定 ' + vals[0] + ']';
      }
    });
    const est = $('sweep-estimate');
    const fixedTxt = fixed.length ? '　|　📌 固定: ' + fixed.join(', ') : '';
    const untouchedTxt = untouched.length
      ? '　|　⚪ 未设置(默认): ' + untouched.slice(0, 8).join(', ') + (untouched.length > 8 ? ' 等 ' + untouched.length + ' 项' : '')
      : '';
    let disabled = TestStore.running;
    if (!any) {
      est.textContent = '请至少为一个参数填写数值（多个值=扫描，单个值=固定）。';
      est.className = 'sweep-est warn';
    } else if (TestStore.sweepMode === 'greedy') {
      if (tests === 0) {
        est.textContent = '⚠️ 智能寻优需要至少一个参数填多个值（多个值=候选档位）。';
        est.className = 'sweep-est warn';
        disabled = true;
      } else {
        est.textContent = '🔍 智能寻优：逐个参数依次优化，其余参数固定在当前最优。最多 ' + (tests * 2) + ' 次测试（' + fmtDur(tests * 2 * PER_COMBO_SEC) + '）' + fixedTxt + untouchedTxt;
        est.className = 'sweep-est';
      }
    } else {
      const dur = fmtDur(total * PER_COMBO_SEC);
      const parts = [];
      if (swept.length) parts.push('🔀 扫描: ' + swept.join(' × ') + ' = ' + total + ' 种组合');
      else parts.push('📌 仅固定配置，测 1 次');
      if (fixed.length) parts.push('📌 固定: ' + fixed.join(', '));
      const detail = parts.join('　|　');
      if (total > CAP) {
        const sampled = Math.min(total, CAP);
        const dur2 = fmtDur(sampled * PER_COMBO_SEC);
        est.textContent = '⚠️ 穷举 ' + total + ' 种超上限（' + CAP + '），将自动「覆盖采样」≈' + sampled + ' 种代表组合（保证每个参数每档都测到，' + dur2 + '）' + fixedTxt + '。点击开始即可运行。';
        est.className = 'sweep-est warn';
      } else {
        est.textContent = detail + '（' + dur + '）' + untouchedTxt;
        est.className = 'sweep-est';
      }
    }
    document.getElementById('test-start').disabled = disabled;
  }

  function onTestStart() {
    if (document.getElementById('tab-sweep').hidden) {
      startTest();
    } else {
      startSweep();
    }
  }

  function startSweep() {
    if (TestStore.running) return;
    const modelId = document.getElementById('sweep-model').value;
    if (!modelId) { showToast('请选择模型', 'err'); return; }
    const params = [];
    document.querySelectorAll('#sweep-params input[data-key]').forEach(inp => {
      const vals = String(inp.value || '').split(',').map(s => s.trim()).filter(Boolean);
      if (vals.length) params.push({ key: inp.dataset.key, values: vals });
    });
    if (!params.length) { showToast('请至少为一个参数填写多个值', 'err'); return; }
    
    TestStore.reset('sweep');
    TestStore.sweepItems = [];
    TestStore.items = TestStore.sweepItems;
    renderSweepResult();
    document.getElementById('sweep-radar-wrap').hidden = true;
    document.getElementById('test-start').disabled = true;
    document.getElementById('test-start').textContent = TestStore.sweepMode === 'greedy' ? '⏳ 寻优中…' : '⏳ 扫描中…';
    document.getElementById('test-summary').textContent = TestStore.sweepMode === 'greedy' ? '🔍 正在智能寻优…' : '🔬 正在扫描…';
    setTestProgress(0, 0, '准备中…');

    api(API.testSweep, {
      method: 'POST',
      body: JSON.stringify({
        model_id: modelId,
        prompt: document.getElementById('sweep-prompt').value.trim(),
        max_tokens: parseInt(document.getElementById('sweep-max-tokens').value, 10) || 32,
        mode: TestStore.sweepMode,
        repeats: parseInt(document.getElementById('sp-repeats').value, 10) || 1,
        warmup: document.getElementById('sp-warmup').checked,
        ctx: parseInt(document.getElementById('sp-ctx').value, 10) || 0,
        params: params
      })
    }).then(r => {
      if (r && r.job_id) {
        const total = r.total || 0;
        TestStore.setRunning(r.job_id, total);
        if (r.sampled) {
          document.getElementById('test-summary').textContent = `🔬 穷举 ${r.original_total || '?'} 种超限，自动「覆盖采样」测试 ${total} 种代表组合…`;
        }
        if (total && TestStore.sweepMode !== 'greedy') {
          TestStore.sweepItems = new Array(total).fill(null).map((_, i) => ({ combo: i, label: '组合 ' + (i+1), status: 'pending' }));
          TestStore.items = TestStore.sweepItems;
          renderSweepResult();
        }
      }
    }).catch(e => {
      showToast('❌ 扫描启动失败：' + e.message, 'err');
      TestStore.stopRunning();
    });
  }

  function updateSweepItem(msg) {
    const isGreedy = msg.mode === 'greedy';
    if (msg.stage && msg.status === undefined) {
      setStage(msg.stage);
      return;
    }
    if (msg.type === 'sweep_progress') {
      const idx = msg.combo;
      if (idx < 0 || idx >= TestStore.sweepItems.length) {
        while (TestStore.sweepItems.length <= idx) {
          TestStore.sweepItems.push({ combo: TestStore.sweepItems.length, label: '组合 ' + (TestStore.sweepItems.length+1), status: 'pending' });
        }
        TestStore.items = TestStore.sweepItems;
      }
      const it = TestStore.sweepItems[idx];
      if (msg.label) it.label = msg.label;
      if (msg.status) it.status = msg.status;
      if (msg.step) it.step = msg.step;
      if (msg.fixed) it.fixed = msg.fixed;
      if (msg.load_ms !== undefined) it.load_ms = msg.load_ms;
      if (msg.tps !== undefined) it.tps = msg.tps;
      if (msg.tokens !== undefined) it.tokens = msg.tokens;
      if (msg.error !== undefined) it.error = msg.error;
      if (msg.prompt_ps !== undefined) it.prompt_ps = msg.prompt_ps;
      if (msg.prompt_ms !== undefined) it.prompt_ms = msg.prompt_ms;
      if (msg.eval_ms !== undefined) it.eval_ms = msg.eval_ms;
      if (msg.repeats !== undefined) it.repeats = msg.repeats;
      if (msg.cached !== undefined) it.cached = msg.cached;
      if (msg.vram_gb !== undefined) it.vram_gb = msg.vram_gb;
      if (msg.audit !== undefined) it.audit = msg.audit;
      renderSweepResult();

      if (!isGreedy && msg.elapsed_ms && msg.combo >= 0 && msg.total) {
        const avg = msg.elapsed_ms / (msg.combo + 1);
        const remain = avg * (msg.total - msg.combo - 1);
        document.getElementById('test-summary').textContent = `🔬 扫描中… 已完成 ${msg.combo + 1} / ${msg.total}（已用 ${fmtDur(msg.elapsed_ms/1000)} · 剩余 ${fmtDur(remain/1000)}）`;
      } else {
        document.getElementById('test-summary').textContent = isGreedy
          ? `🔍 寻优中… ${msg.step || ''}（${msg.combo + 1}/${msg.total}）`
          : `🔬 扫描中… 已完成 ${msg.combo + 1} / ${msg.total}`;
      }
      if (msg.total > 0) {
        setTestProgress(msg.combo + 1, msg.total, `${msg.combo + 1} / ${msg.total}`);
      }
    } else if (msg.type === 'sweep_done') {
      const results = msg.results || [];
      if (msg.best_params && !msg.cancelled) {
        TestStore.lastBest = {
          modelId: document.getElementById('sweep-model').value,
          params: msg.best_params,
          meta: msg.best_meta || {},
          label: msg.best_label || ''
        };
      } else {
        TestStore.lastBest = null;
      }
      TestStore.finish(results, !!msg.cancelled);
      renderSweepRadar();
    }
  }

  // ── 测试结果图表 / 取消 / 导出 / 历史 ─────────────────────
  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  const testRowCache = new Map();

  function renderTestResult() {
    const box = document.getElementById('test-result');
    const items = TestStore.batchItems;
    while (box.children.length < items.length) {
      const row = document.createElement('div');
      row.className = 'test-row';
      box.appendChild(row);
    }
    while (box.children.length > items.length) {
      const last = box.lastChild;
      testRowCache.delete(parseInt(last.dataset.index));
      box.removeChild(last);
    }
    items.forEach((it, idx) => {
      const row = box.children[idx];
      row.dataset.index = idx;
      const icon = it.status === 'ok' ? '✅' : it.status === 'fail' ? '❌' : '⏳';
      const cls = it.status === 'ok' ? 'ok' : it.status === 'fail' ? 'error' : 'info';
      row.className = `test-row ${cls}`;
      const stats = [];
      if (it.status === 'ok') {
        stats.push('加载 ' + ((it.load_ms / 1000).toFixed(1)) + 's');
        if (it.tps) stats.push('吞吐 ' + it.tps.toFixed(1) + ' tok/s');
        stats.push('生成 ' + it.tokens + ' tok');
      } else if (it.status === 'fail') {
        stats.push(it.error || '失败');
      } else {
        stats.push('启动中…');
      }
      row.innerHTML = `
        <span class="t-icon">${icon}</span>
        <span class="t-name">${esc(it.name)}</span>
        <span class="t-stat">${esc(stats.filter(Boolean).join(' | '))}</span>
        ${it.audit && it.audit.length ? `<span class="t-audit" data-audit="${esc(it.bundle_id)}">📋</span>` : ''}
      `;
    });
    renderTestChart();
  }

  const sweepRowCache = new Map();

  function renderSweepResult() {
    const box = document.getElementById('sweep-result');
    const items = TestStore.sweepItems;
    if (!items || !items.length) {
      box.innerHTML = '<div class="empty-hint">尚未开始扫描。</div>';
      return;
    }
    while (box.children.length < items.length) {
      const row = document.createElement('div');
      row.className = 'test-row';
      box.appendChild(row);
    }
    while (box.children.length > items.length) {
      const last = box.lastChild;
      sweepRowCache.delete(parseInt(last.dataset.index));
      box.removeChild(last);
    }
    items.forEach((it, idx) => {
      if (!it) return;
      const row = box.children[idx];
      row.dataset.index = idx;
      const icon = it.status === 'ok' ? (it.isBest ? '🏆' : '✅') : it.status === 'fail' ? '❌' : '⏳';
      const cls = it.status === 'ok' ? (it.isBest ? 'ok best' : 'ok') : it.status === 'fail' ? 'error' : 'info';
      row.className = `test-row ${cls}`;
      const stats = [];
      if (it.status === 'ok') {
        stats.push('加载 ' + ((it.load_ms / 1000).toFixed(1)) + 's');
        if (it.prompt_ms) stats.push('首token ' + Math.round(it.prompt_ms) + 'ms');
        if (it.tps) stats.push(it.tps.toFixed(1) + ' tok/s');
        stats.push(it.tokens + ' tok');
        if (it.vram_gb) stats.push('显存 ' + it.vram_gb.toFixed(1) + 'GB');
        if (it.repeats > 1) stats.push('×' + it.repeats + '次');
        if (it.cached) stats.push('⚡复用');
      } else if (it.status === 'fail') {
        stats.push(it.error || '失败');
      } else {
        stats.push('启动中…');
      }
      const label = it.label || ('组合 ' + (idx+1));
      row.innerHTML = `
        <span class="t-icon">${icon}</span>
        <span class="t-name">${esc(label)}</span>
        <span class="t-stat">${esc(stats.filter(Boolean).join(' | '))}</span>
        ${it.audit && it.audit.length ? `<span class="t-audit" data-audit="${it.combo}">📋</span>` : ''}
      `;
    });
    renderSweepChart();
  }

  function renderTestChart() {
    const el = document.getElementById('test-chart');
    if (!el || typeof echarts === 'undefined') return;
    const ok = TestStore.batchItems.filter(i => i.status === 'ok' && i.tps);
    if (!ok.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    if (!window.__testChart) window.__testChart = echarts.init(el);
    const colors = ['#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#f44336', '#8bc34a', '#3f51b5'];
    window.__testChart.setOption({
      title: { text: '吞吐对比（tok/s，越高越快）', left: 'center', textStyle: { fontSize: 12 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 50, right: 16, bottom: 28, top: 34 },
      xAxis: { type: 'category', data: ok.map(i => truncate(i.name, 16)), axisLabel: { fontSize: 10, rotate: 20 } },
      yAxis: { type: 'value', name: 'tok/s', nameTextStyle: { fontSize: 10 } },
      series: [{
        type: 'bar', barMaxWidth: 40,
        data: ok.map((i, idx) => ({ value: +(i.tps.toFixed(1)), itemStyle: { color: colors[idx % colors.length] } })),
        label: { show: true, position: 'top', fontSize: 10 }
      }]
    }, true);
  }

  function renderSweepChart() {
    const el = document.getElementById('sweep-chart');
    if (!el || typeof echarts === 'undefined') return;
    const metric = document.getElementById('sweep-chart-metric').value;
    const wrap = el.closest('.test-chart');
    if (metric === 'pareto') { renderParetoChart(el, wrap); return; }
    const pick = (it) => {
      if (metric === 'prompt_ms') return it.prompt_ms || 0;
      if (metric === 'load_ms') return it.load_ms || 0;
      return it.tps || 0;
    };
    const lower = metric !== 'tps';
    const ok = TestStore.sweepItems.filter(i => i && i.status === 'ok' && pick(i) > 0)
      .sort((a, b) => lower ? (pick(a) - pick(b)) : (pick(b) - pick(a)));
    if (!ok.length) { if (wrap) wrap.hidden = true; return; }
    if (wrap) wrap.hidden = false;
    if (!window.__sweepChart) window.__sweepChart = echarts.init(el);
    const names = { tps: '吞吐 tok/s（橙=最高）', prompt_ms: '首 token 延迟 ms（橙=最低）', load_ms: '加载时间 ms（橙=最低）' };
    const unit = { tps: 'tok/s', prompt_ms: 'ms', load_ms: 'ms' }[metric];
    window.__sweepChart.setOption({
      title: { text: '各组合对比 · ' + names[metric], left: 'center', textStyle: { fontSize: 12 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 50, right: 16, bottom: 44, top: 34 },
      xAxis: { type: 'category', data: ok.map(i => truncate(i.label || '', 12)), axisLabel: { fontSize: 9, rotate: 35 } },
      yAxis: { type: 'value', name: unit, nameTextStyle: { fontSize: 10 } },
      series: [{
        type: 'bar', barMaxWidth: 26,
        data: ok.map((i, idx) => ({ value: +(pick(i).toFixed(1)), itemStyle: { color: idx === 0 ? '#ff9800' : '#2196f3' } })),
        label: { show: true, position: 'top', fontSize: 9 }
      }]
    }, true);
  }

  function renderParetoChart(el, wrap) {
    const pts = TestStore.sweepItems.filter(i => i && i.status === 'ok' && i.tps && i.vram_gb > 0)
      .map(i => ({ x: i.vram_gb, y: i.tps, label: i.label || '' }));
    if (!pts.length) { if (wrap) wrap.hidden = true; return; }
    if (wrap) wrap.hidden = false;
    if (!window.__sweepChart) window.__sweepChart = echarts.init(el);
    const sorted = pts.slice().sort((a, b) => a.x - b.x);
    const frontier = [];
    let bestY = -1;
    sorted.forEach(p => {
      if (p.y > bestY) { bestY = p.y; frontier.push(p); }
    });
    window.__sweepChart.setOption({
      title: { text: '🎯 帕累托前沿（显存 GB × 吞吐）', left: 'center', textStyle: { fontSize: 12 } },
      tooltip: { trigger: 'item', formatter: function(p) {
        if (p.seriesIndex === 1) return '前沿 ' + p.data.label + '<br/>显存 ' + p.data.x.toFixed(1) + ' GB · ' + p.data.y.toFixed(1) + ' tok/s';
        return p.data.label + '<br/>显存 ' + p.data.x.toFixed(1) + ' GB · ' + p.data.y.toFixed(1) + ' tok/s';
      }},
      legend: { bottom: 0, data: ['组合', '前沿'] },
      grid: { left: 55, right: 22, bottom: 40, top: 34 },
      xAxis: { type: 'value', name: '显存 GB', nameTextStyle: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'tok/s', nameTextStyle: { fontSize: 10 } },
      series: [
        { name: '组合', type: 'scatter', symbolSize: 11, data: pts.map(p => ({ value: [p.x, p.y], label: p.label })), itemStyle: { color: '#2196f3', opacity: 0.75 } },
        { name: '前沿', type: 'line', smooth: true, symbolSize: 9, data: frontier.map(p => ({ value: [p.x, p.y], label: p.label })), lineStyle: { color: '#ff9800', width: 2 }, itemStyle: { color: '#ff9800' } }
      ]
    }, true);
  }

  function renderSweepRadar() {
    const wrap = document.getElementById('sweep-radar-wrap');
    const el = document.getElementById('sweep-radar');
    if (!wrap || !el || typeof echarts === 'undefined') return;
    const ok = TestStore.sweepItems.filter(i => i && i.status === 'ok' && i.tps);
    if (!ok.length) { wrap.hidden = true; return; }
    let best = ok[0];
    ok.forEach(i => { if (i.tps > best.tps) best = i; });
    const dims = [
      { key: 'tps', name: '吞吐', higher: true },
      { key: 'prompt_ms', name: '首token延迟', higher: false },
      { key: 'load_ms', name: '加载', higher: false },
      { key: 'vram_gb', name: '显存', higher: false }
    ];
    const val = (it, key) => {
      if (key === 'tps') return it.tps || 0;
      if (key === 'prompt_ms') return it.prompt_ms || 0;
      if (key === 'load_ms') return it.load_ms || 0;
      return it.vram_gb || 0;
    };
    const mm = {};
    dims.forEach(d => {
      let mn = Infinity, mx = -Infinity;
      ok.forEach(it => { const v = val(it, d.key); if (v < mn) mn = v; if (v > mx) mx = v; });
      mm[d.key] = { mn, mx };
    });
    const norm = (it, d) => {
      const m = mm[d.key];
      if (m.mx === m.mn) return 1;
      const r = (val(it, d.key) - m.mn) / (m.mx - m.mn);
      return d.higher ? r : 1 - r;
    };
    const avg = {};
    dims.forEach(d => avg[d.key] = 0);
    ok.forEach(it => dims.forEach(d => avg[d.key] += val(it, d.key)));
    dims.forEach(d => avg[d.key] /= ok.length);
    const avgVals = dims.map(d => {
      const m = mm[d.key];
      if (m.mx === m.mn) return 1;
      const r = (avg[d.key] - m.mn) / (m.mx - m.mn);
      return d.higher ? r : 1 - r;
    });
    if (!window.__sweepRadar) window.__sweepRadar = echarts.init(el);
    const bestName = '最优 ' + (best.tps ? best.tps.toFixed(1) + ' tok/s' : '');
    window.__sweepRadar.setOption({
      tooltip: {},
      legend: { bottom: 0, data: [bestName, '平均'] },
      radar: { indicator: dims.map(d => ({ name: d.name, max: 1 })), radius: '60%' },
      series: [{
        type: 'radar',
        data: [
          { name: bestName, value: dims.map(d => +norm(best, d).toFixed(2)), areaStyle: { color: 'rgba(76,175,80,0.30)' }, lineStyle: { color: '#4caf50' }, itemStyle: { color: '#4caf50' } },
          { name: '平均', value: avgVals.map(v => +v.toFixed(2)), areaStyle: { color: 'rgba(33,150,243,0.18)' }, lineStyle: { color: '#2196f3' }, itemStyle: { color: '#2196f3' } }
        ]
      }]
    }, true);
    wrap.hidden = false;
  }

  // ── 6 阶段状态机 ──────────────────────
  const STAGES2 = ['queued', 'validating', 'auditing', 'warming_up', 'benchmarking', 'cleaning'];

  function auditTableHTML(audit) {
    if (!audit || !audit.length) return '';
    const rows = audit.map(function (a) {
      const icon = a.same ? '✅' : '⚠️';
      return '<tr class="' + (a.same ? 'same' : 'diff') + '"><td>' + esc(a.label || a.key) + '</td><td>' + esc(a.requested || '—') + '</td><td>' + esc(a.effective || '—') + '</td><td>' + icon + ' ' + esc(a.note || '') + '</td></tr>';
    }).join('');
    return '<div class="audit-box"><table class="audit-table"><thead><tr><th>参数</th><th>请求</th><th>实际生效</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function cancelTestRun() {
    const isSweep = !document.getElementById('tab-sweep').hidden;
    const jobId = TestStore.jobId;
    if (!jobId) return;
    TestStore.running = false;
    document.getElementById('test-cancel').disabled = true;
    document.getElementById('test-start').disabled = false;
    document.getElementById('test-summary').textContent = '⏹ 正在取消…';
    api(API.testCancel, { method: 'POST', body: JSON.stringify({ job_id: jobId }) })
      .then(() => {
        showToast(isSweep ? '⏹ 已请求取消扫描' : '⏹ 已请求取消测试', 'info');
      })
      .catch(() => {
        showToast('❌ 取消失败，请重试', 'err');
      });
  }

  function exportTestReport() {
    const isSweep = !document.getElementById('tab-sweep').hidden;
    const items = isSweep ? TestStore.sweepItems : TestStore.batchItems;
    if (!items || !items.length) {
      showToast('没有结果可导出', 'err');
      return;
    }
    const rows = isSweep
      ? [['组合', '状态', '加载(ms)', '吞吐(tok/s)', '生成(tok)', '错误']]
      : [['模型', '状态', '加载(ms)', '吞吐(tok/s)', '生成(tok)', '错误']];
    items.forEach(it => {
      if (!it) return;
      rows.push([it.label || it.name || '', it.status, it.load_ms || 0, it.tps ? it.tps.toFixed(2) : '', it.tokens || 0, it.error || '']);
    });
    const csv = rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (isSweep ? 'sweep_' : 'test_') + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function buildSnapName(isSweep, items) {
    const best = items.filter(function (it) { return it && it.status === 'ok' && it.tps; })
      .sort(function (a, b) { return b.tps - a.tps; })[0];
    const bits = [];
    if (best) {
      if (best.tps) bits.push(best.tps.toFixed(1) + ' tok/s');
      if (best.vram_gb) bits.push(best.vram_gb.toFixed(1) + 'GB');
      if (best.load_ms) bits.push((best.load_ms / 1000).toFixed(0) + 's 加载');
    }
    return (isSweep ? '🔬 扫描 ' : '🖥 测试 ') + (bits.join(' · ') || new Date().toLocaleTimeString().slice(0, 5));
  }

  function saveCurrentSnapshot(rename) {
    const isSweep = !document.getElementById('tab-sweep').hidden;
    const items = isSweep ? TestStore.sweepItems : TestStore.batchItems;
    if (!items || !items.length || !items.some(function (it) { return it && it.status; })) {
      if ($('test-savesnap')) flashBtn($('test-savesnap'), '✗ 无结果');
      return;
    }
    const name = buildSnapName(isSweep, items);
    if (rename) {
      $('test-savesnap').hidden = true;
      if ($('btn-snap-rename')) $('btn-snap-rename').hidden = true;
      $('snap-row').hidden = false;
      $('snap-name').value = name;
      $('snap-name').focus();
      $('snap-name').select();
      return;
    }
    confirmSnapshot(name);
  }

  function confirmSnapshot(forcedName) {
    const btn = document.getElementById('snap-confirm');
    const isSweep = !document.getElementById('tab-sweep').hidden;
    const items = isSweep ? TestStore.sweepItems : TestStore.batchItems;
    if (!items || !items.length) {
      showToast('没有结果可保存', 'err');
      return;
    }
    const modelSel = isSweep ? document.getElementById('sweep-model') : null;
    const modelId = modelSel ? modelSel.value : '';
    const name = (forcedName != null ? forcedName : document.getElementById('snap-name').value.trim()) || '结果快照';
    const payload = items.filter(it => it).map(it => ({
      name: it.label || it.name || ('组合 ' + it.combo),
      status: it.status || '',
      load_ms: it.load_ms || 0,
      tps: it.tps || 0,
      tokens: it.tokens || 0,
      prompt_ms: it.prompt_ms || 0,
      repeats: it.repeats || 0,
      cached: !!it.cached,
      vram_gb: it.vram_gb || 0,
      audit: it.audit || [],
      error: it.error || ''
    }));
    const okCount = payload.filter(x => x.status === 'ok').length;
    let summary = '共测 ' + payload.length + ' 次 · ✅ ' + okCount + ' 成功';
    const ok = payload.filter(x => x.status === 'ok' && x.tps).sort((a, b) => b.tps - a.tps);
    if (ok.length) summary += ' · 最佳 ' + ok[0].name + '（' + ok[0].tps.toFixed(1) + ' tok/s）';
    const body = {
      name: name, type: isSweep ? 'sweep' : 'batch',
      mode: isSweep ? TestStore.sweepMode : '',
      model: modelId,
      prompt: isSweep ? document.getElementById('sweep-prompt').value : document.getElementById('test-prompt').value,
      max_tokens: parseInt((isSweep ? document.getElementById('sweep-max-tokens') : document.getElementById('test-max-tokens')).value, 10) || 0,
      summary: summary,
      params: collectSweepParams(),
      items: payload
    };
    btn.disabled = true;
    api('/api/test/history/save', { method: 'POST', body: JSON.stringify(body) })
      .then(() => {
        document.getElementById('snap-row').hidden = true;
        document.getElementById('test-savesnap').hidden = false;
        document.getElementById('btn-snap-rename').hidden = false;
        btn.disabled = false;
        showToast('✅ 已保存为快照：' + name, 'ok');
        renderTestHistory();
      })
      .catch(e => {
        btn.disabled = false;
        showToast('❌ 保存失败：' + (e.message || '未知错误'), 'err');
      });
  }

  function cancelSnapshot() {
    document.getElementById('snap-row').hidden = true;
    document.getElementById('test-savesnap').hidden = false;
    document.getElementById('btn-snap-rename').hidden = false;
  }

  function collectSweepParams() {
    const pm = {};
    document.querySelectorAll('#sweep-params .sweep-row').forEach(function (r) {
      const k = r.dataset.key;
      const inp = r.querySelector('input[data-key]');
      if (k && inp && String(inp.value || '').trim()) pm[k] = String(inp.value).trim();
    });
    return pm;
  }

  function renderTestHistory() {
    const box = $('test-history-list');
    if (!box) return;
    api(API.testHistory).then(function (res) {
      const list = (res && res.records) || [];
      const filt = $('hist-filter') ? $('hist-filter').value : 'all';
      if (!list.length) { box.innerHTML = '<div class="empty-hint">暂无测试历史。完成一次测试/扫描后会记录到这里。</div>'; return; }
      const currentModel = $('sweep-model') ? $('sweep-model').value : '';
      let filtered = list.filter(function (rec) {
        if (filt === 'sweep' && rec.type !== 'sweep') return false;
        if (filt === 'batch' && rec.type !== 'batch') return false;
        if (filt === 'saved' && !rec.saved) return false;
        if (filt !== 'saved' && currentModel && rec.model && rec.model !== currentModel) return false;
        return true;
      });
      if (!filtered.length) filtered = list.slice(0, 20);

      let html = '<div class="hist-toolbar"><span class="modal-info" style="flex:1"></span>' +
        '<button class="btn small" id="hist-compare-btn" disabled>📊 对比选中（2-3条）</button></div>';
      html += filtered.map(function (rec, idx) {
        const icon = rec.type === 'sweep' ? '🔬' : '🖥';
        const savedTag = rec.saved ? '<span class="hist-saved" title="手动保存的快照，不被自动淘汰">📌</span> ' : '';
        const nameTag = rec.name ? '<span class="hist-name">' + esc(rec.name) + '</span>' : '';
        const sub = rec.type === 'sweep'
          ? (rec.mode === 'greedy' ? '🔍 智能寻优' : '🔬 参数扫描') + ' · ' + (rec.model || '')
          : '';
        const items = (rec.items || []).slice(0, 10).map(function (it) {
          const cls = it.status === 'ok' ? 'ok' : 'err';
          const txt = it.name + (it.status === 'ok'
            ? ' → ' + (it.tps ? it.tps.toFixed(1) + ' tok/s · ' : '') + Math.round((it.load_ms || 0) / 1000) + 's'
            : ' → ' + (it.error || it.status));
          return '<div class="test-hist-item ' + cls + '">' + esc(txt) + '</div>';
        }).join('');
        const more = (rec.items || []).length > 10 ? '<div class="test-hist-more">… 共 ' + rec.items.length + ' 项</div>' : '';
        return '<div class="test-hist-card' + (rec.saved ? ' saved' : '') + '" data-idx="' + idx + '">' +
          '<div class="test-hist-head"><input type="checkbox" class="hist-cb" data-idx="' + idx + '">' +
          '<span>' + icon + ' ' + savedTag + '<b>' + esc(rec.time) + '</b></span>' + nameTag +
          '<span class="test-hist-sub">' + esc(rec.summary || '') + (sub ? '　·　' + esc(sub) : '') + '</span>' +
          '<button class="btn tiny test-hist-detail" data-id="' + esc(rec.id) + '" title="查看详情（参数/结果/导出）">👁</button>' +
          '<button class="btn tiny test-hist-export" data-id="' + esc(rec.id) + '" title="导出该条为 CSV">📥</button></div>' +
          items + more + '</div>';
      }).join('');

      box.innerHTML = html;
      const compareBtn = document.getElementById('hist-compare-btn');
      const cbs = box.querySelectorAll('.hist-cb');
      cbs.forEach(function (cb) {
        cb.addEventListener('change', function () {
          const checked = box.querySelectorAll('.hist-cb:checked').length;
          compareBtn.disabled = checked < 2 || checked > 3;
          compareBtn.textContent = checked >= 2 ? '📊 对比选中（' + checked + '条）' : '📊 对比选中（2-3条）';
        });
      });
      if (compareBtn) {
        compareBtn.addEventListener('click', function () {
          const checked = box.querySelectorAll('.hist-cb:checked');
          if (checked.length < 2 || checked.length > 3) return;
          const indices = Array.from(checked).map(function (cb) { return parseInt(cb.dataset.idx, 10); });
          const records = indices.map(function (i) { return filtered[i]; });
          renderHistoryDiff(records);
        });
      }
      box.querySelectorAll('.test-hist-export').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const rec = list.find(function (x) { return x.id === btn.dataset.id; });
          if (rec) exportHistoryRecord(rec);
        });
      });
      box.querySelectorAll('.test-hist-detail').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const rec = list.find(function (x) { return x.id === btn.dataset.id; });
          if (rec) renderHistoryDetail(rec);
        });
      });
    }).catch(function () { box.innerHTML = '<div class="empty-hint">加载历史失败。</div>'; });
  }

  function renderHistoryDetail(rec) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'detail-modal';
    overlay.style.display = 'flex';
    overlay.innerHTML = '<div class="modal-box" style="max-width:96%;width:1100px;max-height:90vh;overflow:auto;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;"><h3>👁 ' + esc(rec.name || (rec.type === 'sweep' ? '扫描详情' : '测试详情')) + '</h3>' +
      '<div style="display:flex;gap:8px;"><button data-export class="btn">📥 导出 CSV</button><button data-close class="btn">✕ 关闭</button></div></div>' +
      '<div id="detail-body"></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('[data-close]').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('[data-export]').addEventListener('click', function () { exportHistoryRecord(rec); });

    const body = overlay.querySelector('#detail-body');
    let html = '<div class="hist-overview">' +
      '<span>🕐 ' + esc(rec.time) + '</span>' +
      (rec.name ? '<span>🏷 ' + esc(rec.name) + '</span>' : '') +
      '<span>📝 ' + esc(rec.summary || '') + '</span>' +
      (rec.model ? '<span>🎯 ' + esc(rec.model) + '</span>' : '') +
      (rec.prompt ? '<span>💬 ' + esc(truncate(rec.prompt, 60)) + '</span>' : '') +
      '</div>';
    const params = rec.params || {};
    const keys = Object.keys(params);
    if (keys.length) {
      html += '<h4 style="margin:12px 0 6px">⚙️ 扫描参数</h4><table class="audit-table"><thead><tr><th>参数</th><th>档位（逗号=扫描）</th></tr></thead><tbody>';
      keys.forEach(function (k) {
        const v = Array.isArray(params[k]) ? params[k].join(', ') : String(params[k] == null ? '' : params[k]);
        html += '<tr><td><strong>' + esc(k) + '</strong></td><td>' + esc(v) + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '<h4 style="margin:12px 0 6px">📊 结果（' + (rec.items || []).length + ' 项）</h4><table class="audit-table"><thead><tr><th>组合</th><th>状态</th><th>加载</th><th>吞吐</th><th>首token</th><th>token</th><th>显存</th><th>错误</th></tr></thead><tbody>';
    (rec.items || []).forEach(function (it) {
      html += '<tr><td>' + esc(it.name || '') + '</td>' +
        '<td>' + (it.status === 'ok' ? '✅' : it.status === 'fail' ? '❌' : esc(it.status || '—')) + '</td>' +
        '<td>' + ((it.load_ms || 0) / 1000).toFixed(1) + 's</td>' +
        '<td>' + (it.tps ? it.tps.toFixed(2) : '—') + '</td>' +
        '<td>' + (it.prompt_ms ? Math.round(it.prompt_ms) + 'ms' : '—') + '</td>' +
        '<td>' + (it.tokens || 0) + '</td>' +
        '<td>' + (it.vram_gb ? it.vram_gb.toFixed(1) + 'GB' : '—') + '</td>' +
        '<td>' + esc(it.error || '') + '</td></tr>';
    });
    html += '</tbody></table>';
    const audited = (rec.items || []).find(function (it) { return it.audit && it.audit.length; });
    if (audited) {
      html += '<h4 style="margin:12px 0 6px">📋 参数审计（' + esc(audited.name) + '）</h4><table class="audit-table"><thead><tr><th>参数</th><th>请求</th><th>实际生效</th><th>说明</th></tr></thead><tbody>';
      audited.audit.forEach(function (a) {
        const same = a.same ? '✅' : '⚠️';
        html += '<tr><td>' + esc(a.label || a.key) + '</td><td>' + esc(a.requested) + '</td><td>' + esc(a.effective) + ' ' + same + '</td><td>' + esc(a.note || '') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    body.innerHTML = html;
  }

  function renderHistoryDiff(records) {
    if (!records || records.length < 2) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'diff-modal';
    overlay.style.display = 'flex';
    overlay.innerHTML = '<div class="modal-box" style="max-width:95%;width:1200px;max-height:90vh;overflow:auto;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;"><h3>📊 历史对比</h3>' +
      '<div style="display:flex;gap:8px;"><button data-exportdiff class="btn">📥 导出对比 CSV</button><button data-close class="btn">✕ 关闭</button></div></div>' +
      '<div id="diff-body"></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('[data-close]').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('[data-exportdiff]').addEventListener('click', function () { exportHistoryDiff(records); });

    const body = overlay.querySelector('#diff-body');
    const extractParams = function (rec) {
      const ok = (rec.items || []).find(function (it) { return it.status === 'ok'; });
      if (ok && ok.audit && ok.audit.length) {
        const p = {};
        ok.audit.forEach(function (a) { p[a.key] = a.effective || a.requested; });
        return p;
      }
      const p = {};
      const rp = rec.params || {};
      Object.keys(rp).forEach(function (k) {
        const v = rp[k];
        p[k] = Array.isArray(v) ? v.join(',') : String(v == null ? '' : v);
      });
      return p;
    };
    const paramsList = records.map(extractParams);
    const allKeys = new Set();
    paramsList.forEach(function (p) { Object.keys(p).forEach(function (k) { allKeys.add(k); }); });
    const diffKeys = Array.from(allKeys).filter(function (k) {
      const vals = paramsList.map(function (p) { return p[k] || ''; });
      return vals.some(function (v) { return v !== vals[0]; });
    });

    let tableHtml = '<table class="audit-table"><thead><tr><th>参数</th>';
    records.forEach(function (r, i) { tableHtml += '<th>Run ' + (i+1) + '<br><small>' + r.time.slice(5,16) + '</small></th>'; });
    tableHtml += '<th>差异</th></tr></thead><tbody>';
    if (diffKeys.length === 0) {
      tableHtml += '<tr><td colspan="' + (records.length+2) + '" style="text-align:center;color:#8b949e;">✅ 所有参数一致，差异可能来自环境或随机性</td></tr>';
    } else {
      diffKeys.forEach(function (k) {
        const vals = paramsList.map(function (p) { return p[k] || '—'; });
        const first = vals[0];
        const isNumeric = vals.every(function (v) { return v !== '—' && !isNaN(parseFloat(v)); });
        let diffLabel = '';
        if (isNumeric) {
          const nums = vals.map(function (v) { return parseFloat(v); });
          const min = Math.min.apply(null, nums);
          const max = Math.max.apply(null, nums);
          const pct = ((max - min) / (Math.abs(min) + 0.001) * 100).toFixed(0);
          diffLabel = '↕ ' + pct + '% 变化';
        } else {
          diffLabel = '⚡ 不同值';
        }
        tableHtml += '<tr><td><strong>' + esc(k) + '</strong></td>';
        vals.forEach(function (v) {
          const isBest = isNumeric && parseFloat(v) === Math.max.apply(null, vals.map(function (x) { return parseFloat(x) || 0; }));
          tableHtml += '<td' + (isBest ? ' style="color:#4caf50;font-weight:bold;"' : '') + '>' + esc(v) + '</td>';
        });
        tableHtml += '<td>' + diffLabel + '</td></tr>';
      });
    }
    tableHtml += '</tbody></table>';

    let envMsg = '';
    if (records.some(function (r) { return r.env && r.env.binary_fp; })) {
      const fps = records.map(function (r) { return r.env ? r.env.binary_fp : ''; });
      if (fps.some(function (f) { return f !== fps[0]; })) {
        envMsg = '⚠️ 环境差异：llama-server 版本不同，TPS 差异可能含环境因素';
      }
    }
    if (envMsg) {
      envMsg = '<div class="audit-item warn" style="margin-bottom:12px;">' + envMsg + '</div>';
    }

    const tpsList = records.map(function (r) {
      const ok = (r.items || []).find(function (it) { return it.status === 'ok' && it.tps; });
      return ok ? ok.tps : 0;
    });
    let summary = '';
    if (tpsList.every(function (t) { return t > 0; })) {
      const max = Math.max.apply(null, tpsList);
      const min = Math.min.apply(null, tpsList);
      const pct = ((max - min) / (min + 0.001) * 100).toFixed(0);
      const bestIdx = tpsList.indexOf(max);
      summary = '🏆 最佳 Run ' + (bestIdx+1) + '（' + max.toFixed(1) + ' tok/s），比最慢快 ' + pct + '%';
      if (diffKeys.length) {
        const key = diffKeys[0];
        const vals = paramsList.map(function (p) { return p[key] || '—'; });
        summary += '，主要变化 ' + key + ' = ' + vals.join(' → ');
      }
    } else {
      summary = '部分 Run 无有效 TPS 数据，请检查失败项';
    }

    body.innerHTML = envMsg + tableHtml +
      '<div style="margin-top:16px;padding:12px;background:var(--bg-secondary);border-radius:8px;">📌 ' + summary + '</div>' +
      '<div id="diff-radar" style="height:260px;margin-top:16px;"></div>';

    if (typeof echarts !== 'undefined') {
      const el = document.getElementById('diff-radar');
      const chart = echarts.init(el);
      const dims = ['TPS', 'TTFT', 'Load', 'VRAM'];
      const series = records.map(function (rec, i) {
        const ok = (rec.items || []).find(function (it) { return it.status === 'ok'; });
        if (!ok) return { name: 'Run ' + (i+1), value: [0,0,0,0] };
        const tps = ok.tps || 0;
        const ttft = ok.prompt_ms || 0;
        const load = (ok.load_ms || 0) / 1000;
        const vram = ok.vram_gb || 0;
        const all = records.map(function (r) {
          const o = (r.items || []).find(function (it) { return it.status === 'ok'; });
          return o ? { tps: o.tps || 0, ttft: o.prompt_ms || 0, load: (o.load_ms || 0)/1000, vram: o.vram_gb || 0 } : { tps:0, ttft:0, load:0, vram:0 };
        });
        const maxTps = Math.max.apply(null, all.map(function (x) { return x.tps; })) || 1;
        const maxTtft = Math.max.apply(null, all.map(function (x) { return x.ttft; })) || 1;
        const maxLoad = Math.max.apply(null, all.map(function (x) { return x.load; })) || 1;
        const maxVram = Math.max.apply(null, all.map(function (x) { return x.vram; })) || 1;
        return {
          name: 'Run ' + (i+1),
          value: [
            tps / maxTps,
            1 - (ttft / maxTtft),
            1 - (load / maxLoad),
            1 - (vram / maxVram)
          ]
        };
      });
      chart.setOption({
        tooltip: {},
        legend: { bottom: 0, data: series.map(function (s) { return s.name; }) },
        radar: { indicator: dims.map(function (d) { return { name: d, max: 1 }; }), radius: '65%' },
        series: [{
          type: 'radar',
          data: series.map(function (s) {
            return { name: s.name, value: s.value, areaStyle: { opacity: 0.3 } };
          })
        }]
      });
      window.addEventListener('resize', function () { chart.resize(); });
    }
  }

  function clearTestHistory() {
    if (!confirm('确定清空全部测试历史？')) return;
    api(API.testHistory, { method: 'DELETE' }).then(function () {
      renderTestHistory();
      flashBtn($('btn-hist-clear'), '✓ 已清空');
    });
  }

  function exportHistoryRecord(rec) {
    const rows = [
      ['时间', rec.time],
      ['类型', rec.type === 'sweep' ? (rec.mode === 'greedy' ? '智能寻优' : '参数扫描') : '批量测试'],
      ['模型', rec.model || ''], ['提示', rec.prompt || ''], ['最大token', rec.max_tokens || ''],
      ['摘要', rec.summary || ''], [],
      ['项', '状态', '加载(ms)', '吞吐(tok/s)', '生成(tok)', '错误']
    ];
    (rec.items || []).forEach(function (it) {
      rows.push([it.name, it.status, it.load_ms || 0, it.tps ? it.tps.toFixed(2) : '', it.tokens || 0, it.error || '']);
    });
    const csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'test_history_' + rec.id + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportHistoryDiff(records) {
    const getBest = function (r) {
      return (r.items || []).filter(function (it) { return it.status === 'ok' && it.tps; })
        .sort(function (a, b) { return b.tps - a.tps; })[0];
    };
    const okItems = records.map(getBest);
    const rows = [['对比导出', records.length + ' 条历史', new Date().toLocaleString()], []];
    rows[1].push('指标');
    records.forEach(function (r, i) { rows[1].push('Run ' + (i + 1) + ' ' + (r.name || '')); });
    const metrics = [
      ['吞吐 (tok/s)', function (it) { return it ? it.tps.toFixed(2) : ''; }],
      ['首 token (ms)', function (it) { return it && it.prompt_ms ? Math.round(it.prompt_ms) : ''; }],
      ['加载 (ms)', function (it) { return it ? it.load_ms : ''; }],
      ['生成 (tok)', function (it) { return it ? it.tokens : ''; }],
      ['显存 (GB)', function (it) { return it && it.vram_gb ? it.vram_gb.toFixed(1) : ''; }],
      ['次数', function (it) { return it && it.repeats ? it.repeats : 1; }]
    ];
    metrics.forEach(function (m) {
      const row = [m[0]];
      okItems.forEach(function (it) { row.push(m[1](it)); });
      rows.push(row);
    });
    rows.push([]);
    const paramsList = records.map(function (r) { return r.params || {}; });
    const allKeys = new Set();
    paramsList.forEach(function (p) { Object.keys(p).forEach(function (k) { allKeys.add(k); }); });
    const diffKeys = Array.from(allKeys).filter(function (k) {
      const vals = paramsList.map(function (p) {
        const v = p[k]; return Array.isArray(v) ? v.join(',') : String(v == null ? '' : v);
      });
      return vals.some(function (v) { return v !== vals[0]; });
    });
    if (diffKeys.length) {
      rows.push(['参数差异']);
      diffKeys.forEach(function (k) {
        const row = [k];
        paramsList.forEach(function (p) {
          const v = p[k];
          row.push(Array.isArray(v) ? v.join(',') : String(v == null ? '' : v));
        });
        rows.push(row);
      });
    }
    const csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'compare_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function saveBestConfig(rename) {
    if (!TestStore.lastBest) {
      showToast('没有最优配置可保存', 'err');
      return;
    }
    const m = TestStore.lastBest.meta || {};
    const bits = [];
    if (m.ctx_size) bits.push(m.ctx_size + ' ctx');
    if (m.n_gpu_layers !== undefined && m.n_gpu_layers !== null) bits.push('GPU' + m.n_gpu_layers);
    if (m.tps) bits.push(m.tps.toFixed(1) + ' tok/s');
    if (m.mode === 'greedy') bits.push('寻优');
    const name = '🏆 ' + (bits.join(' · ') || '最优配置');
    if (rename) {
      document.getElementById('savecfg-name').value = name;
      document.getElementById('test-savecfg').hidden = true;
      document.getElementById('btn-savecfg-rename').hidden = true;
      document.getElementById('savecfg-row').hidden = false;
      document.getElementById('savecfg-name').focus();
      document.getElementById('savecfg-name').select();
      return;
    }
    saveConfigNow(name);
  }

  function saveConfigNow(forcedName) {
    if (!TestStore.lastBest) {
      document.getElementById('savecfg-row').hidden = true;
      document.getElementById('test-savecfg').hidden = false;
      document.getElementById('btn-savecfg-rename').hidden = false;
      return;
    }
    const name = (forcedName != null ? forcedName : document.getElementById('savecfg-name').value.trim()) || '最优配置';
    const btn = document.getElementById('savecfg-confirm');
    btn.disabled = true;
    api('/api/bundles/' + TestStore.lastBest.modelId + '/configs', {
      method: 'POST',
      body: JSON.stringify({ name: name, params: TestStore.lastBest.params, meta: TestStore.lastBest.meta })
    }).then(() => {
      document.getElementById('savecfg-row').hidden = true;
      document.getElementById('test-savecfg').hidden = false;
      document.getElementById('btn-savecfg-rename').hidden = false;
      btn.disabled = false;
      showToast('✅ 已保存到模型库：' + name, 'ok');
      refreshBundles();
    }).catch(e => {
      btn.disabled = false;
      showToast('❌ 保存失败：' + (e.message || '未知错误'), 'err');
    });
  }

  function applyConfigFull(b, c) {
    const params = c.params || {};
    Object.keys(params).forEach(key => {
      const el = document.getElementById('p-' + key);
      if (el) {
        if (el.type === 'checkbox') el.checked = !!params[key];
        else el.value = params[key];
      }
    });
    document.getElementById('model-select').value = b.id;
    selectedId = b.id;
    onModelChangeMeta();
    refreshPreview();
    runAudit();
    const banner = document.createElement('div');
    banner.className = 'audit-item info apply-banner';
    banner.textContent = `🧪 已套用配置「${c.name}」：${Object.keys(params).length} 个参数已覆盖`;
    const box = document.getElementById('audit-box');
    if (box) {
      const old = box.querySelector('.apply-banner');
      if (old) old.remove();
      box.prepend(banner);
      setTimeout(() => banner.remove(), 5000);
    }
    showToast(`✅ 已套用配置「${c.name}」`, 'ok');
  }

  function applyTestConfig(bundleId, cfgId) {
    const b = bundles.find(x => x.id === bundleId);
    if (!b) return;
    const c = (b.test_configs || []).find(x => x.id === cfgId);
    if (!c) return;
    applyConfigFull(b, c);
  }

  function applySelectedConfig() {
    const b = bundles.find(x => x.id === selectedId);
    if (!b) return;
    const c = (b.test_configs || []).find(x => x.id === document.getElementById('test-config-select').value);
    if (!c) return;
    applyConfigFull(b, c);
  }

  function deleteTestConfig(bundleId, cfgId) {
    if (!confirm('删除该测试配置？')) return;
    api('/api/bundles/' + bundleId + '/configs/' + cfgId, { method: 'DELETE' })
      .then(refreshBundles)
      .catch(function (e) { alert('删除失败: ' + e.message); });
  }

  // 重置表单到模型默认（用于「🧹 还原」）
  function resetFormToModelDefault(b) {
    document.querySelectorAll('[id^="p-"]').forEach(function (el) {
      if (el.type === 'checkbox') { el.checked = false; return; }
      if (el.tagName === 'SELECT') { if (el.options && el.options.length) el.selectedIndex = 0; return; }
      if (el.value !== undefined) el.value = '';
    });
    const dp = b.default_params || {};
    if (dp.ctx_size) $('p-ctx_size').value = dp.ctx_size;
    if (dp.n_gpu_layers !== undefined && dp.n_gpu_layers !== null) $('p-n_gpu_layers').value = dp.n_gpu_layers;
    if (dp.flash_attn) $('p-flash_attn').value = dp.flash_attn;
    if (dp.load_mode) $('p-load_mode').value = dp.load_mode;
    if (dp.cpu_moe) $('p-cpu_moe').checked = true;
  }

  function applyOfficialDefaults(b) {
    (paramDefs || []).forEach(function (p) {
      const el = $('p-' + p.key);
      if (!el) return;
      const d = p.default;
      if (d === undefined || d === null || d === '') {
        if (el.type === 'checkbox') el.checked = false;
        else if (el.value !== undefined) el.value = '';
        return;
      }
      if (el.type === 'checkbox') { el.checked = !!d; return; }
      if (el.tagName === 'SELECT') {
        const v = String(d);
        let found = false;
        Array.from(el.options).forEach(function (o) { if (String(o.value) === v) { el.value = o.value; found = true; } });
        if (!found) el.selectedIndex = 0;
        return;
      }
      if (el.value !== undefined) el.value = d;
    });
    if (!b) return;
    const dp = b.default_params || {};
    if (dp.ctx_size) $('p-ctx_size').value = dp.ctx_size;
    if (dp.n_gpu_layers !== undefined && dp.n_gpu_layers !== null) $('p-n_gpu_layers').value = dp.n_gpu_layers;
    if (dp.flash_attn) $('p-flash_attn').value = dp.flash_attn;
    if (dp.load_mode) $('p-load_mode').value = dp.load_mode;
    if (dp.cpu_moe) $('p-cpu_moe').checked = true;
  }

  // ── 工具 ──────────────────────────────
  function fmtMB(mb) {
    if (!mb) return '-';
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
  }

  function baseName(p) {
    if (!p) return '';
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- 新增：参数搜索与动态可见性功能 ----
  function initParamSearch() {
    const input = document.getElementById('param-search');
    const clear = document.getElementById('param-search-clear');
    if (!input) return;
    input.addEventListener('input', function () {
      const query = this.value.trim().toLowerCase();
      clear.classList.toggle('show', query.length > 0);
      document.querySelectorAll('.cfg-group .field').forEach(function (field) {
        const label = field.querySelector('label')?.textContent?.toLowerCase() || '';
        const inputEl = field.querySelector('input, select');
        const id = inputEl?.id || '';
        const match = label.includes(query) || id.includes(query);
        field.classList.toggle('hidden-param', !match);
      });
    });
    if (clear) {
      clear.addEventListener('click', function () {
        input.value = '';
        input.dispatchEvent(new Event('input'));
      });
    }
  }

  function loadGroupStates() {
    const states = JSON.parse(localStorage.getItem('paramGroupStates') || '{}');
    document.querySelectorAll('.cfg-group').forEach(function (group) {
      const key = group.dataset.group;
      if (states[key] === 'collapsed') {
        group.classList.add('collapsed');
      }
    });
  }

  function updateParamVisibility(bundle) {
    // 参数依赖规则：哪些组或字段需要根据模型类型显示/隐藏
    // 这里我们用 data-depends 属性标记字段，也可直接隐藏整个组
    const isMoE = bundle && (bundle.tags || []).includes('moe');
    const isVision = bundle && (bundle.tags || []).includes('vision');
    const isMTP = bundle && (bundle.tags || []).includes('mtp');

    // 处理 MoE 相关字段（需在对应 field 上加 data-depends="moe"）
    document.querySelectorAll('[data-depends="moe"]').forEach(function (el) {
      const field = el.closest('.field');
      if (field) {
        field.style.display = isMoE ? '' : 'none';
      }
    });
    // 处理视觉相关字段
    document.querySelectorAll('[data-depends="vision"]').forEach(function (el) {
      const field = el.closest('.field');
      if (field) {
        field.style.display = isVision ? '' : 'none';
      }
    });
    // v4：投机解码组（🚀启用开关 + 草稿模型 + 草稿参数）对任何模型都可用
    // （draft-simple/MTP/ngram），始终显示、不隐藏，用户可折叠；不再受 MTP 限制
    const specGroup = document.querySelector('.cfg-group[data-group="spec"]');
    if (specGroup) { specGroup.dataset.hidden = 'false'; }
    // 其他依赖逻辑可扩展
  }

  // ---- 新增：参数变更高亮函数（用于预设/优化后） ----
  function highlightChangedParams(oldParams, newParams) {
    const changedKeys = Object.keys(newParams).filter(function (k) {
      return oldParams[k] !== newParams[k];
    });
    changedKeys.forEach(function (key) {
      const el = document.getElementById('p-' + key);
      if (el) {
        el.classList.remove('param-flash');
        void el.offsetWidth; // 强制回流
        el.classList.add('param-flash');
        setTimeout(function () { el.classList.remove('param-flash'); }, 2000);
      }
    });
  }

  // ---- 新增：在应用预设或优化时保存旧参数并高亮 ----
  // 在 applyScenarioPreset 和 onOptimize 函数中调用 highlightChangedParams
  // 修改 applyScenarioPreset 和 onOptimize 函数：
  // 原 onOptimize 在最后调用 refreshPreview() 和 runAudit() 之前，增加高亮调用。
  // 原 applyScenarioPreset 在最后调用 refreshPreview() 和 scheduleAudit() 之前，增加高亮。

  // 由于这两个函数已定义，我们直接覆盖它们（或者用猴子补丁，但这里建议直接修改原有函数）
  // 如果你不想覆盖原函数，可以修改原有的 applyScenarioPreset 和 onOptimize 代码。
  // 我们将在后续给出修改后的完整这两个函数。

  // ---- 结束新增 ----

  window.TestBatch = { update: updateTestItem, updateSweep: updateSweepItem };

  document.addEventListener('DOMContentLoaded', init);
})();
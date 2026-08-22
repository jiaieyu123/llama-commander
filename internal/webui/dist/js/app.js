// app.js — Llama Commander 前端主逻辑
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

  // 生成随机 API Key（256 位，sk- 前缀），免手打
  function genAPIKey() {
    const bytes = new Uint8Array(32);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += ALPHA[bytes[i] % ALPHA.length];
    return 'sk-' + s;
  }

  // 复制到剪贴板（含降级方案），按钮短暂显示反馈
  function flashBtn(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1200);
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
    // 已保存加密 Key 且尚未回显 → 点击时拉取明文显示（不点就不加载明文）
    if (input.type === 'password' && !input.value && cfgHasAPIKey) {
      api(API.configKey).then(function (r) {
        input.value = r.key || '';
        input.type = 'text'; btn.textContent = '🙈';
        const hint = $('set-key-hint');
        if (hint) hint.textContent = '🔓 已回显明文（点击 💾 保存将重新加密存储）';
      }).catch(function () { flashBtn(btn, '✗'); });
      return;
    }
    if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
    else { input.type = 'password'; btn.textContent = '👁'; }
  }

  // 打开界面时自动把全局 API Key 填入主面板输入框（仅输入框为空时，不覆盖手动输入）
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

  // ── 初始化 ────────────────────────────
  function init() {
    PerfChart.init();
    LogConsole.connect();
    refreshAll();
    autoFillGlobalKey();
    setInterval(refreshStatus, 5000);
    setInterval(updateUptimes, 1000); // 运行时长计时器

    $('btn-refresh-models').addEventListener('click', refreshBundles);
    $('model-select').addEventListener('change', onModelChange);
    $('test-config-select').addEventListener('change', function () { if (selectedId && this.value) applySelectedConfig(); });
    $('btn-apply-config').addEventListener('click', function () { if ($('test-config-select').value) applySelectedConfig(); });
    $('btn-optimize').addEventListener('click', onOptimize);
    $('btn-params-help').addEventListener('click', openParamsHelp);
    loadParams();
    // 数字字段预设下拉 → 选中填入目标输入框并刷新预览
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
    // 打开当前选中模型运行实例的 Web 界面
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
    // 概览页内嵌监控的刷新/导出按钮（与监控弹窗共用数据）
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
    $('set-key-clear').addEventListener('click', clearAPIKey);
    $('set-key-gen').addEventListener('click', function () {
      $('set-api-key').value = genAPIKey();
      cfgAPIKeyChanged = true;
      $('set-key-hint').textContent = '🎲 已生成随机 Key（256 位），点击 💾 保存后自动注入到每个实例。';
    });
    $('p-key-gen').addEventListener('click', function () {
      $('p-api_key').value = genAPIKey();
      refreshPreview();
    });
    $('p-key-copy').addEventListener('click', function () { copyKey($('p-api_key').value, this); });
    $('p-key-toggle').addEventListener('click', function () { toggleKeyVisibility($('p-api_key'), this); });
    $('set-key-copy').addEventListener('click', function () {
      const kInput = $('set-api-key');
      if (!kInput.value && cfgHasAPIKey) {
        // 已保存但未回显 → 拉取明文直接复制
        api(API.configKey).then(function (r) {
          if (r.key) copyKey(r.key, $('set-key-copy'));
          else flashBtn($('set-key-copy'), '空');
        }).catch(function () { flashBtn($('set-key-copy'), '✗'); });
      } else {
        copyKey(kInput.value, this);
      }
    });
    $('set-key-toggle').addEventListener('click', function () { toggleKeyVisibility($('set-api-key'), this); });
    $('set-api-key').addEventListener('input', function () { cfgAPIKeyChanged = true; });
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
    $('btn-hist-clear').addEventListener('click', clearTestHistory);
    $('btn-hist-refresh').addEventListener('click', renderTestHistory);
    $('test-start').addEventListener('click', onTestStart);
    $('test-savecfg').addEventListener('click', saveBestConfig);
    $('savecfg-confirm').addEventListener('click', saveConfigNow);
    $('savecfg-cancel').addEventListener('click', function () {
      $('savecfg-row').hidden = true;
      $('test-savecfg').hidden = false;
    });
    $('test-tabs').addEventListener('click', function (e) {
      const btn = e.target.closest('.tab');
      if (btn) switchTestTab(btn.dataset.tab);
    });
    document.querySelectorAll('.sweep-modebar .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        sweepMode = c.dataset.smode;
        document.querySelectorAll('.sweep-modebar .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
        sweepItems = [];
        sweepBest = -1;
        $('test-summary').textContent = '';
        lastBest = null;
        $('test-savecfg').hidden = true;
        $('savecfg-row').hidden = true;
        $('btn-sweep-fillall').hidden = sweepMode !== 'greedy';
        renderSweepResult();
        updateSweepEstimate();
        $('test-start').textContent = sweepMode === 'greedy' ? '▶ 开始寻优' : '▶ 开始扫描';
      });
    });
    $('btn-sweep-fillall').addEventListener('click', fillAllSweepParams);
    document.querySelectorAll('.scenario-bar .chip[data-scenario]').forEach(function (c) {
      c.addEventListener('click', function () { applyScenario(c.dataset.scenario); });
    });
    $('btn-sweep-clear').addEventListener('click', clearAllSweepParams);
    $('sweep-radar-close').addEventListener('click', function () { $('sweep-radar-wrap').hidden = true; });
    $('btn-sweep-settings').addEventListener('click', function () {
      const box = $('sweep-settings');
      box.hidden = !box.hidden;
      this.textContent = box.hidden ? '⚙️ 扫描设置 ▾' : '⚙️ 扫描设置 ▴';
    });
    $('sweep-add-param').addEventListener('change', onAddSweepParam);
    $('sweep-chart-metric').addEventListener('change', renderSweepChart);
    // 参数审计展开（sweep 结果行 📋）——事件委托，重渲染后仍有效
    $('sweep-result').addEventListener('click', function (e) {
      const btn = e.target.closest('.t-audit');
      if (!btn) return;
      const it = sweepItems[parseInt(btn.dataset.audit, 10)];
      if (!it || !it.audit || !it.audit.length) return;
      let box = document.getElementById('audit-' + btn.dataset.audit);
      if (box) { box.remove(); return; }
      const div = document.createElement('div');
      div.id = 'audit-' + btn.dataset.audit;
      div.innerHTML = auditTableHTML(it.audit);
      btn.closest('.test-row').after(div);
    });
    // 参数审计展开（batch 结果行 📋）
    $('test-result').addEventListener('click', function (e) {
      const btn = e.target.closest('.t-audit');
      if (!btn) return;
      const it = testItems.find(function (x) { return x.bundle_id === btn.dataset.audit; });
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

    // API 调试面板
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
    // 文件/目录浏览器
    $('scan-browse').addEventListener('click', function () { openFSBrowser('dir', 'scan-dir'); });
    $('set-cache-browse').addEventListener('click', function () { openFSBrowser('dir', 'set-cache-dir'); });
    $('fs-go').addEventListener('click', function () { loadFS($('fs-path').value.trim()); });
    $('fs-up').addEventListener('click', function () {
      if (fsCurrent.parent) loadFS(fsCurrent.parent);
    });
    $('fs-home').addEventListener('click', function () { loadFS(''); });
    $('fs-select').addEventListener('click', selectFSDir);
    $('fs-path').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadFS($('fs-path').value.trim()); });

    // 弹窗关闭：只通过 ✕ / 关闭按钮关闭。
    // （不监听遮罩点击——避免用户在弹窗外的区域误点导致弹窗意外关闭。）
    document.querySelectorAll('.modal-overlay').forEach(function (ov) {
      ov.querySelectorAll('[data-close]').forEach(function (btn) {
        btn.addEventListener('click', function () { ov.hidden = true; });
      });
    });

    // 主区域 Tab 切换（🏠概览 / ⚙️模型配置 / 🚀运行实例 / 📋控制台）
    document.querySelectorAll('#main-tabs .main-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchMainTab(b.dataset.mtab); });
    });
    switchMainTab('setup');

    // ── SaaS 侧边栏交互 ──
    // 侧边栏折叠 / 汉堡（窄屏离屏抽屉）
    const sbToggle = $('btn-sidebar-toggle');
    if (sbToggle) sbToggle.addEventListener('click', function () {
      if (window.innerWidth <= 900) {
        document.body.classList.toggle('sidebar-open');
      } else {
        document.body.classList.toggle('sidebar-collapsed');
      }
    });
    // 侧边栏全局搜索：实时过滤模型库，Enter 选中并切到配置页
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
    // 促销卡「快速启动」→ 切到配置页并触发启动
    const qs = $('btn-quick-start');
    if (qs) qs.addEventListener('click', function () {
      switchMainTab('setup');
      if (selectedId) onStart(); else flashBtn(qs, '请先选择模型');
    });
    // 通知铃铛（简单提示）
    const nf = $('btn-notify');
    if (nf) nf.addEventListener('click', function () {
      flashBtn(nf, '暂无新通知');
    });
    // 顶栏刷新按钮
    const trf = $('btn-top-refresh');
    if (trf) trf.addEventListener('click', function () {
      refreshAll();
      flashBtn(trf, '已刷新');
    });

    // 界面动态设置：恢复上次偏好 + 绑定主题/布局/紧凑切换
    applyUISettings(loadUISettings());
    ['ui-theme', 'ui-layout'].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener('change', saveUISettings);
    });
    const uiCp = $('ui-compact');
    if (uiCp) uiCp.addEventListener('change', saveUISettings);
    // 场景预设：一键应用常见使用场景的最佳参数组合
    $('scenario-preset').addEventListener('change', function () {
      if (this.value) applyScenarioPreset(this.value);
    });
    $('btn-scenario-clear').addEventListener('click', function () {
      $('scenario-preset').value = '';
      flashBtn($('btn-scenario-clear'), '已还原');
    });
    $('scan-dir').addEventListener('keydown', function (e) { if (e.key === 'Enter') scanDir(); });

    document.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () { applyPreset(chip.dataset.preset); });
    });

    // 参数变化 → 实时命令预览 + 实时审计（风险提示）
    var auditTimer = null;
    document.querySelectorAll('#config-panel input, #config-panel select').forEach(function (el) {
      el.addEventListener('input', function () { refreshPreview(); scheduleAudit(); });
      el.addEventListener('change', function () { refreshPreview(); scheduleAudit(); });
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
      // 已保存的测试配置列表
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

  // ── 上下文预设（随模型最大上下文动态生成）──────────
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
    // MTP 检测：文件名/路径含 mtp|nextn（nextn = llama.cpp 下一 token 网络张量
    // 前缀，很多带 MTP 头的模型如 Qwen-VL 文件名不含 mtp）或带 mtp 标签。
    const _n = ((b.name || '') + ' ' + ((b.base_model || {}).path || '')).toLowerCase();
    const isMtp = _n.includes('mtp') || _n.includes('nextn') || (b.tags || []).includes('mtp');
    window.__isMtp = isMtp;
    // 能力徽标：MTP（兼容旧 bundle tags 缺失）+ 其他能力标签
    const badges = tagBadges(b.tags || []);
    // 避免 MTP 徽标重复（tags 含 mtp 时 tagBadges 已出，这里仅兜底文件名检测）
    const capStr = ((isMtp && !(b.tags || []).includes('mtp') ? '🧩 MTP ' : '') + badges).trim();
    meta.textContent = `📷 视觉: ${vis} | ⚡ 草稿: ${draft} | 🧩 MCP: ${mcp} | 🏷️ 能力: ${capStr || '—'}`;

    // mmproj 字段提示自动检测路径（留空=自动）
    const mmEl = $('p-mmproj');
    if (mmEl) mmEl.placeholder = (b.mmproj && b.mmproj.path) ? '自动: ' + b.mmproj.path : '未检测到 mmproj，可手动填写';

    // 🧩 投机解码组始终显示（MTP 模型或外部草稿模型都能用）。
    // MTP 模型默认勾选启用 draft-mtp（用主模型自带 MTP 头投机），避免 MTP
    // 张量被当作 unused tensor 忽略；普通模型需填独立草稿模型才会生效。
    const specEl = $('p-spec_type');
    if (specEl && isMtp && !specEl.checked) specEl.checked = true;

    // 用模型默认参数填充表单
    const dp = b.default_params || {};
    if (dp.ctx_size) $('p-ctx_size').value = dp.ctx_size;
    if (dp.n_gpu_layers !== undefined) $('p-n_gpu_layers').value = dp.n_gpu_layers;
    if (dp.flash_attn) $('p-flash_attn').value = dp.flash_attn;
    if (dp.load_mode) $('p-load_mode').value = dp.load_mode;
    if (dp.cpu_moe) $('p-cpu_moe').checked = true;

    // 上下文预设：随模型最大上下文动态生成（25% / 50% / 75% / 原生最大）
    const maxCtx = Number(((b.base_model || {}).metadata || {}).context_length || 0);
    const pCtxSel = $('p-ctx_size') ? $('p-ctx_size').closest('.num-wrap').querySelector('.preset') : null;
    fillCtxPreset(pCtxSel, maxCtx, DEFAULT_CTX_PRESET_HTML);

    // 测试配置选择器：列出该模型已保存的最优配置
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
  }

  // ── 一键优化（接入后端 VRAM 估算）────
  function onOptimize() {
    if (!selectedId) { alert('请先选择模型'); return; }
    const btn = $('btn-optimize');
    btn.disabled = true; btn.textContent = '⏳ 计算中…';
    api(API.recommend, { method: 'POST', body: JSON.stringify({ bundle_id: selectedId, scene: 'speed', params: collectParams() }) })
      .then(function (r) {
        const rec = r.recommendation;
        if (rec.ctx_size) $('p-ctx_size').value = rec.ctx_size;
        if (rec.n_gpu_layers !== undefined && rec.n_gpu_layers !== null) $('p-n_gpu_layers').value = rec.n_gpu_layers;
        if (rec.flash_attn) $('p-flash_attn').value = rec.flash_attn;
        if (rec.threads) $('p-threads').value = rec.threads;
        if (rec.kv_cache_k) $('p-cache_type_k').value = rec.kv_cache_k;
        if (rec.kv_cache_v) $('p-cache_type_v').value = rec.kv_cache_v;
        if (rec.load_mode) $('p-load_mode').value = rec.load_mode;
        if (rec.parallel !== undefined && rec.parallel !== null) $('p-parallel').value = rec.parallel;
        $('p-cpu_moe').checked = !!rec.cpu_moe;
        // 视觉模型纯文本场景：mmproj 走 CPU 省显存给主模型层
        if (rec.mmproj_cpu) $('p-no_mmproj_offload').checked = true;
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
      applyParamTooltips();
      // 网络板块 API Key 字段显示全局 Key 配置状态
      api(API.configGet).then(function (c) {
        const el = $('p-api_key');
        if (!el) return;
        el.title = '仅对本次启动的实例生效；留空 = 自动使用 ⚙️设置 里保存的全局 API Key。' +
          (c.has_api_key ? '\n\n当前已配置全局 Key，留空会自动注入。' : '\n\n当前未配置全局 Key。');
        el.placeholder = c.has_api_key ? '留空=自动用全局 Key' : '可选（未设全局 Key）';
      }).catch(function () { /* 忽略 */ });
    }).catch(function () { /* 帮助系统不可用时静默降级 */ });
  }
  function applyParamTooltips() {
    paramDefs.forEach(function (p) {
      const el = $('p-' + p.key);
      if (!el) return;
      const parts = [];
      const def = fmtDefault(p.default);
      if (def) parts.push('默认: ' + def);
      if (p.enum && p.enum.length) parts.push('可选: ' + p.enum.join(' / '));
      el.title = parts.join('\n') + (p.help ? '\n\n' + p.help : '');
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

  // 场景预设：对话/代码/长文档/省显存/高速 一键填常用参数组合
  const SCENARIO_PRESETS = {
    chat: { ctx_size: 4096, batch_size: 2048, flash_attn: 'on', cache_type_k: 'f16', cache_type_v: 'f16' },
    code: { ctx_size: 8192, batch_size: 4096, flash_attn: 'on', cache_type_k: 'f16', cache_type_v: 'f16', temperature: 0.2 },
    doc:  { ctx_size: 32768, batch_size: 1024, flash_attn: 'on', cache_type_k: 'q8_0', cache_type_v: 'q8_0', temperature: 0.1 },
    vram: { ctx_size: 2048, batch_size: 512, flash_attn: 'on', cache_type_k: 'q8_0', cache_type_v: 'q8_0', kv_unified: true },
    fast: { ctx_size: 4096, batch_size: 8192, flash_attn: 'on', cache_type_k: 'f16', cache_type_v: 'f16', parallel: 4 }
  };
  function applyScenarioPreset(name) {
    const p = SCENARIO_PRESETS[name];
    if (!p) return;
    Object.keys(p).forEach(function (k) {
      const el = $('p-' + k);
      if (el && p[k] !== undefined) el.value = p[k];
    });
    refreshPreview();
    if (typeof scheduleAudit === 'function') scheduleAudit();
    flashBtn($('scenario-preset'), '✓ 已应用');
  }

  // 主区域 Tab 切换：显示对应 data-mtab 的面板，隐藏其它
  // （🏠概览 = 性能监控 / ⚙️模型配置 = 参数面板 / 🚀运行实例 = 实例卡片 / 📋控制台 = 日志）
  function switchMainTab(name) {
    document.querySelectorAll('#main-tabs .main-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mtab === name);
    });
    document.querySelectorAll('section.panel[data-mtab]').forEach(function (s) {
      s.classList.toggle('mtab-active', s.dataset.mtab === name);
    });
    // 顶部工具栏面包屑同步
    const crumbMap = { overview: '📊 性能监控', setup: '⚙️ 模型配置', instances: '🚀 运行实例', console: '📋 控制台' };
    const crumb = $('topbar-crumb');
    if (crumb && crumbMap[name]) crumb.textContent = crumbMap[name];
    // 切到概览时重绘图表 + 刷新内嵌实时监控（容器可能刚从隐藏变为可见，需 resize 避免 0 宽）
    if (name === 'overview') {
      try { if (PerfChart.resize) PerfChart.resize(); } catch (_) {}
      try { if (window.Monitor) Monitor.refresh(); } catch (_) {}
    }
    if (name === 'instances') refreshStatus();
    if (name === 'console' && typeof applyLogFilter === 'function') applyLogFilter();
  }

  // ── 界面动态设置（主题/布局/紧凑，localStorage 持久化）────────
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
    // Tab 式模式下确保有激活面板
    if ((s.layout || 'tabs') === 'tabs') {
      const anyActive = document.querySelector('section.panel[data-mtab].mtab-active');
      if (!anyActive) switchMainTab('setup');
    }
    // 双栏模式：确保图表重绘（容器从隐藏变可见）
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
  function tagBadges(tags) {    const m = { mtp: '🧩 MTP', moe: '🌐 MoE', vision: '📷 视觉', reasoning: '🧠 推理', embedding: '📐 嵌入' };
    const out = [];
    (tags || []).forEach(function (t) { if (m[t]) out.push(m[t]); });
    return out.join(' ');
  }

  // ── 命令预览 ──────────────────────────
  function collectParams() {
    const p = {};
    ['n_gpu_layers', 'ctx_size', 'threads', 'batch_size', 'ubatch_size', 'threads_batch', 'flash_attn', 'cache_type_k',
     'cache_type_v', 'rope_scaling', 'rope_scale', 'mmproj', 'no_mmproj_offload', 'parallel', 'embedding', 'rerank',
     'cache_ram', 'ctx_checkpoints', 'checkpoint_min_step', 'kv_unified', 'threads_http',
     'metrics', 'props', 'slots', 'repeat_penalty', 'presence_penalty', 'frequency_penalty',
     'temperature', 'top_p', 'top_k', 'min_p', 'samplers', 'sampler_seq', 'seed', 'ignore_eos', 'load_mode', 'numa',
     'host', 'port', 'api_key', 'agent'].forEach(function (k) {
      const el = $('p-' + k);
      if (!el) return;
      if (el.type === 'checkbox') { p[k] = el.checked; return; }
      const v = el.value.trim();
      if (v !== '') {
        p[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
      }
    });
    p.cpu_moe = $('p-cpu_moe').checked;
    if ($('p-n_cpu_moe')) {
      const v = $('p-n_cpu_moe').value.trim();
      if (v !== '') p.n_cpu_moe = parseInt(v, 10);
    }
    // 🧩 投机解码（组始终显示）：
    //   MTP 模型勾选 = draft-mtp（用主模型自带 MTP 头投机）
    //   普通模型勾选 + 填独立草稿模型 = draft-simple + model_draft（外部草稿投机）
    //   普通模型勾选但未填草稿模型 = 不发送（无草稿则投机无效）
    //   MTP 模型取消勾选 = none（显式关闭，覆盖后端 MTP 自动兜底）
    const mtp = $('p-spec_type');
    if (mtp && mtp.checked) {
      const isMtpModel = !!window.__isMtp;
      const mdEl = $('p-model_draft');
      const draftPath = mdEl ? mdEl.value.trim() : '';
      if (isMtpModel) {
        p.spec_type = 'draft-mtp'; // 用主模型自带 MTP 头，无需外部草稿
      } else if (draftPath) {
        p.spec_type = 'draft-simple';
        p.model_draft = draftPath; // 外部草稿模型投机必须带草稿路径
      } else {
        return p; // 普通模型未填草稿模型 → 投机无效，不发送
      }
      ['n_gpu_layers_draft', 'spec_draft_threads', 'spec_draft_n_max', 'spec_draft_n_min',
       'spec_draft_p_split', 'spec_draft_p_min'].forEach(function (k) {
        const el = $('p-' + k);
        if (!el) return;
        const v = el.value.trim();
        if (v !== '') p[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
      });
    } else if (mtp && window.__isMtp && !mtp.checked) {
      p.spec_type = 'none';
    }
    return p;
  }

  function refreshPreview() {
    const params = collectParams();
    // Use the real model file path (not the bundle id) in the preview, and pass
    // bundle_id so the server also reflects auto-attached mmproj / --mcp flags.
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

  // 停止当前选中的模型所在实例（若多个，则停止全部）
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

  // 重启当前选中模型的实例（无选中时重启第一个运行实例）
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

  // 会话过滤下拉框（日志控制台按实例查看）
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
    box.innerHTML = '';
    runningSessions.forEach(function (s) {
      const b = bundles.find(x => x.id === s.bundle_id);
      const div = document.createElement('div');
      div.className = 'instance-card';
      div.innerHTML = `
        <div class="status ${esc(s.status)}">${dot(s.status)} ${esc(s.status)}  PID: ${s.pid || '-'}</div>
        <div class="port">:${s.port}</div>
        <div class="meta">${esc(b ? b.name : s.bundle_id)}</div>
        <div class="meta">⏱ <b data-uptime="${esc(s.id)}" data-start="${esc(s.start_time)}" data-status="${esc(s.status)}">--</b></div>
        <div class="actions">
          <button class="btn small" data-stop="${esc(s.id)}">⏹ 停止</button>
          <button class="btn small" data-restart="${esc(s.id)}">🔄 重启</button>
          <button class="btn small" data-open="http://127.0.0.1:${s.port}">🔗 打开</button>
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
      box.appendChild(div);
    });
    updateUptimes();
  }

  // 每秒刷新实例卡片的运行时长（崩溃/停止的实例停止计时）
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

  // 向日志控制台写入一行（复用 LogConsole）
  function appendLog(level, line) {
    if (window.LogConsole) window.LogConsole.append({ ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: level, line: line });
  }

  function dot(s) {
    return s === 'running' ? '●' : s === 'crashed' ? '✖' : '○';
  }

  // ── 配置健康审计（后端真实计算）────────
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
        // VRAM 估算行（审计未覆盖时的补充信息）
        const rec = r.recommendation;
        if (rec && rec.estimated_vram_gb > 0) {
          items.unshift(`<div class="audit-item info">📊 当前配置估算显存占用 ${rec.estimated_vram_gb.toFixed(1)} GB</div>`);
        }
        box.innerHTML = items.join('') || '<div class="audit-item info">✅ 未发现明显问题</div>';
      })
      .catch(function () { box.innerHTML = '<div class="empty-hint">审计不可用。</div>'; });
  }

  // ── 手动添加模型 ──────────────────────
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
    btn.disabled = true; btn.textContent = '⏳ 扫描中…';
    api(API.scan, { method: 'POST', body: JSON.stringify({ dir: dir }) })
      .then(function (r) {
        scanCandidates = r.candidates || [];
        renderScanResults();
        const skipped = r.skipped || [];
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

  function importSelected() {
    const selected = scanCandidates.filter(function (_, i) {
      const cb = document.querySelector(`.scan-item .sel[data-i="${i}"]`);
      return cb && cb.checked;
    });
    if (!selected.length) return;
    const btn = $('scan-import');
    btn.disabled = true; btn.textContent = '⏳ 导入中…';
    const jobs = selected.map(function (c) {
      return api(API.import, { method: 'POST', body: JSON.stringify({ path: c.bundle.base_model.path, name: c.bundle.name }) });
    });
    Promise.all(jobs)
      .then(function () {
        $('scan-modal').hidden = true;
        refreshBundles();
        alert('✅ 已批量导入 ' + selected.length + ' 个模型');
      })
      .catch(function (e) { alert('部分导入失败: ' + e.message); refreshBundles(); })
      .finally(function () { btn.disabled = false; btn.textContent = '📥 批量导入选中'; });
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
        // 每 5 秒刷新模型库，直到新模型出现
        let tries = 0;
        const timer = setInterval(function () {
          tries++;
          refreshBundles();
          if (tries >= 120) clearInterval(timer); // 最多等 10 分钟
        }, 5000);
      })
      .catch(function (e) { st.textContent = '下载启动失败: ' + e.message; });
  }

  // ── 下载进度条（由 WS progress 事件驱动）──
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
  // 数据来自每个实例的全局 /metrics（llama-server 统计该实例所有请求，含外部
  // API Key 调用）。后端每 5s 通过 WS 推送，打开弹窗时先 GET /api/monitor 拿快照。
  // 每实例卡片附带实时趋势图（ECharts，离线自动降级为纯数字）。
  const MonChart = {
    charts: {}, // "sid@container" -> echarts instance（支持弹窗 + 概览内嵌多容器）
    series: {}, // sid -> { pps:[], rps:[], pred:[] }  历史采样（保留 120 点 ≈ 10 分钟）
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
      // 回放到该 sid 的所有容器图表
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
      // 弹窗刷新会重建 DOM → 释放旧图表实例，保留历史 series 供回放
      for (const key in this.charts) { this.charts[key].dispose(); }
      this.charts = {};
    }
  };

  // 监控目标容器：弹窗(#monitor-body) + 概览页(#monitor-inline) 共用一套数据
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
          // 每个容器独立建图（仅当容器可见，避免 0 宽）
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
      if (!cards.length) { this.refresh(); return; } // 新实例 → 重建卡片
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
      MonChart.push(sid, m); // 追加历史采样点并刷新所有容器趋势图
    },
    // ── 请求历史 ──────────────────────
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
    // ── 大图 / 详情弹窗 ────────────────
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
    // ── 导出 CSV ──────────────────────
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

  // 全局辅助：打开指定会话的 Web 界面（供日志控制台等调用）
  window.openInstanceUI = function (sessionId) {
    getRunning().then(function (running) {
      if (!running.length) { alert('没有运行中的实例'); return; }
      const target = sessionId ? running.find(function (s) { return s.id === sessionId; }) : null;
      const pick = target || running[0];
      window.open('http://127.0.0.1:' + pick.port, '_blank');
    });
  };

  // 请求记录单行渲染
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
    if (box.children.length) return; // 保留用户已编辑的消息
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
    // embeddings
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
        // 填入表单
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
    // Token by model
    renderChart('chart-tokens', Object.assign({}, base, {
      xAxis: { type: 'category', data: d.models.map(m => shortName(m.name)), axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.models.map(m => m.tokens), itemStyle: { color: '#4f8cff' } }]
    }));
    // Tokens by day
    renderChart('chart-days', Object.assign({}, base, {
      xAxis: { type: 'category', data: d.days.map(x => x.date.slice(5)) },
      yAxis: { type: 'value' },
      series: [{
        type: 'line', smooth: true, data: d.days.map(x => x.tokens),
        lineStyle: { color: '#7c3aed', width: 2 }, areaStyle: { color: 'rgba(124,58,237,.12)' }
      }]
    }));
    // Model heat (sessions)
    const sorted = d.models.slice().sort((a, b) => b.sessions - a.sessions);
    renderChart('chart-heat', Object.assign({}, base, {
      grid: { left: 120, right: 16, top: 16, bottom: 24 },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: sorted.map(m => shortName(m.name)) },
      series: [{ type: 'bar', data: sorted.map(m => m.sessions), itemStyle: { color: '#d29922' } }]
    }));
    // Avg TPS by model
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

  // ── MCP 服务器管理（注册 / 模板库 / 环境检测 / 健康状态）────────
  function openMCPModal() {
    $('mcp-modal').hidden = false;
    loadMCP();
    loadMCPTemplates();
    checkMCPEnv();
  }

  function loadMCP() {
    const box = $('mcp-list');
    box.innerHTML = '<div class="empty-hint">加载中…</div>';
    // 并行拉取服务器列表 + 健康状态（命令是否在 PATH 上）
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
      const dot = s.enabled
        ? (st.healthy === false ? '<span class="mcp-dot bad" title="命令不在 PATH，可能无法启动"></span>' : '<span class="mcp-dot ok" title="命令可执行"></span>')
        : '<span class="mcp-dot off" title="已停用"></span>';
      const div = document.createElement('div');
      div.className = 'scan-item';
      div.innerHTML =
        '<div>' +
        '<div class="name">' + dot + ' ' + esc(s.name) + (s.enabled ? '' : ' (停用)') + '</div>' +
        '<div class="meta">命令: ' + esc(s.command) + ' ' + esc((s.args || []).join(' ')) + '</div>' +
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
        api('/api/mcp/' + s.id, { method: 'DELETE' }).then(loadMCP);
      });
      box.appendChild(div);
    });
  }

  // 🧪 测试 MCP 命令能否启动（启动后立即终止）
  function testMCP(s, resEl) {
    if (!resEl) return;
    resEl.textContent = '⏳ 测试中…';
    api(API.mcpTest, { method: 'POST', body: JSON.stringify({ command: s.command, args: s.args || [], env: s.env || {} }) })
      .then(function (r) {
        resEl.textContent = r.ok ? '✅ 可执行' : '❌ ' + (r.message || '失败');
        resEl.className = 'mcp-test-result ' + (r.ok ? 'ok' : 'err');
      })
      .catch(function (e) { resEl.textContent = '❌ ' + e.message; resEl.className = 'mcp-test-result err'; });
  }

  // 🔗 把此 MCP 服务器绑定到哪些模型（多选面板，勾选保存）
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
          // 刷新模型库/配置面板以更新 🧩 MCP 徽标
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

  // ── 模板库 ─────────────────────────────
  function loadMCPTemplates() {
    api(API.mcpTemplates).catch(function () { return []; }).then(function (list) {
      renderMCPTemplates(list || []);
    });
  }

  function renderMCPTemplates(templates) {
    const container = $('mcp-template-list');
    if (!container) return;
    if (!templates.length) { container.innerHTML = '<div class="empty-hint">暂无模板。</div>'; return; }
    container.innerHTML = '';
    // 按分类分组展示，推荐排前
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
          const card = document.createElement('div');
          card.className = 'mcp-template-card' + (tpl.recommended ? ' recommended' : '');
          card.innerHTML =
            '<div class="mcp-template-head"><span class="mcp-template-name">' + esc(tpl.name) + '</span>' +
            (tpl.recommended ? '<span class="badge">推荐</span>' : '') + '</div>' +
            '<p class="mcp-template-desc">' + esc(tpl.description) + '</p>' +
            (tpl.hint ? '<p class="mcp-template-hint">💡 ' + esc(tpl.hint) + '</p>' : '') +
            '<button class="btn small" data-tpl="' + esc(tpl.id) + '">＋ 使用此工具</button>';
          card.querySelector('[data-tpl]').addEventListener('click', function () { onAddTemplate(tpl, card); });
          grid.appendChild(card);
        });
      container.appendChild(catEl);
    });
  }

  // 从模板添加：内联配置表单（VS Code 内嵌浏览器不支持 window.prompt，用页面内控件）
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
      api(API.mcpAdd, { method: 'POST', body: JSON.stringify(server) })
        .then(function () { cfg.remove(); loadMCP(); flashBtn(card.querySelector('[data-tpl]'), '✓ 已添加'); })
        .catch(function (e) { alert('添加失败: ' + e.message); });
    });
    card.appendChild(cfg);
  }

  // 环境检测提示
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
  let cfgAPIKeyChanged = false;
  let cfgHasAPIKey = false;

  function openSettings() {
    cfgAPIKeyChanged = false;
    $('settings-modal').hidden = false;
    api(API.configGet).then(function (c) {
      $('set-data-dir').value = c.data_dir || '';
      $('set-binary').value = c.binary_path || '';
      $('set-retention').value = c.log_retention_days || 30;
      $('set-hf').value = c.hf_endpoint || '';
      $('set-cache-dir').value = c.cache_dir || '';
      cfgHasAPIKey = !!c.has_api_key;
      $('set-api-key').value = '';
      $('set-api-key').placeholder = cfgHasAPIKey ? '••••••••（已保存，输入新值可替换）' : '可选，AES-256 加密存储';
      $('set-key-hint').textContent = cfgHasAPIKey ? '🔒 已保存加密 Key · 点 👁 查看明文（不点不会加载明文）' : '';
    }).catch(function (e) { alert('加载设置失败: ' + e.message); });
  }

  function saveSettings() {
    const keyVal = $('set-api-key').value;
    let serverApiKey = '__KEEP__';
    if (cfgAPIKeyChanged && keyVal === '') serverApiKey = '';      // 用户清空 → 清除
    else if (cfgAPIKeyChanged && keyVal !== '') serverApiKey = keyVal; // 新值 → 加密存储

    api(API.configPut, {
      method: 'PUT',
      body: JSON.stringify({
        binary_path: $('set-binary').value.trim(),
        log_retention_days: parseInt($('set-retention').value, 10) || 30,
        hf_endpoint: $('set-hf').value.trim(),
        cache_dir: $('set-cache-dir').value.trim(),
        server_api_key: serverApiKey
      })
    }).then(function () {
      $('settings-modal').hidden = true;
      alert('✅ 设置已保存');
    }).catch(function (e) { alert('保存失败: ' + e.message); });
  }

  function clearAPIKey() {
    cfgAPIKeyChanged = true;
    $('set-api-key').value = '';
    $('set-key-hint').textContent = '🔓 保存后将清除已存 API Key';
  }

  // ── 文件/目录浏览器 ───────────────────
  let fsMode = 'dir';       // 目录选择模式
  let fsTargetId = 'scan-dir'; // 选中目录填入的目标输入框 id
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
    // 选择目录按钮仅在 dir 模式且当前非根目录时显示
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

  // dir 模式：选择当前目录 → 填入目标输入框
  function selectFSDir() {
    const target = document.getElementById(fsTargetId);
    if (target) {
      let p = fsCurrent.path || '';
      if (fsTargetId === 'set-cache-dir') {
        // 自动在所选目录下追加一个命名的缓存子目录，避免缓存直接堆在目录根
        p = p.replace(/[\\/]+$/, '') + '\\llama-cache';
      }
      target.value = p;
    }
    $('fs-modal').hidden = true;
    appendLog('INFO', '📂 已选择目录: ' + fsCurrent.path);
  }

  // ── 批量测试 ───────────────────────────
  let testItems = [];
  let testRunning = false;
  let testJobId = null;

  function openTestModal() {
    $('test-modal').hidden = false;
    renderTestModelList();
    renderSweepModel();
    testItems = [];
    testRunning = false;
    sweepItems = [];
    sweepRunning = false;
    sweepBest = -1;
    lastBest = null;
    $('test-savecfg').hidden = true;
    $('savecfg-row').hidden = true;
    $('test-result').innerHTML = '';
    $('test-summary').textContent = '';
    $('test-start').disabled = false;
    $('test-cancel').hidden = true;
    $('test-export').hidden = true;
    testJobId = null;
    sweepJobId = null;
    if (window.__testChart) { window.__testChart.dispose(); window.__testChart = null; }
    if (window.__sweepChart) { window.__sweepChart.dispose(); window.__sweepChart = null; }
    $('test-chart').style.display = 'none';
    $('sweep-chart').hidden = true;
    switchTestTab('batch');
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
  }

  function startTest() {
    if (testRunning) return;
    const ids = [...document.querySelectorAll('#test-models .tm:checked')].map(function (c) { return c.dataset.id; });
    if (!ids.length) { alert('请至少勾选一个模型'); return; }
    testRunning = true;
    hideStage();
    testItems = ids.map(function (id) { return { bundle_id: id, name: '排队中…', status: 'pending' }; });
    renderTestResult();
    $('test-start').disabled = true;
    $('test-start').textContent = '⏳ 测试中…';
    $('test-summary').textContent = '共 ' + ids.length + ' 个模型，正在逐个测试…';
    const tp = {};
    ['ctx_size', 'n_gpu_layers', 'threads', 'batch_size', 'temperature'].forEach(function (k) {
      const el = $('tp-' + k);
      if (!el) return;
      const v = el.value.trim();
      if (v === '') return;
      tp[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
    });
    api(API.testBatch, {
      method: 'POST',
      body: JSON.stringify({
        bundle_ids: ids,
        prompt: $('test-prompt').value.trim(),
        max_tokens: parseInt($('test-max-tokens').value, 10) || 16,
        params: tp
      })
    }).then(function (r) {
      testJobId = (r && r.job_id) || null;
      if (testJobId) $('test-cancel').hidden = false;
    }).catch(function (e) { alert('测试启动失败: ' + e.message); testRunning = false; });
  }

  // 由 ws.js 推送 test_progress / test_done 事件驱动
  function updateTestItem(msg) {
    // 6 阶段状态机事件（无 status 字段 = 纯阶段广播）
    if (msg.stage && msg.status === undefined) { setStage(msg.stage); return; }
    const it = testItems.find(function (i) { return i.bundle_id === msg.bundle_id; });
    if (it) {
      it.name = msg.name || it.name;
      it.status = msg.status;
      it.load_ms = msg.load_ms;
      it.tps = msg.tps;
      it.tokens = msg.tokens;
      it.error = msg.error;
      it.vram_gb = msg.vram_gb;
      it.audit = msg.audit;
    }
    renderTestResult();
    if (msg.type === 'test_done') {
      testRunning = false;
      hideStage();
      $('test-cancel').hidden = true;
      $('test-export').hidden = (msg.results || []).length === 0;
      const ok = (msg.results || []).filter(function (r) { return r.status === 'ok'; }).length;
      $('test-summary').textContent = msg.cancelled
        ? '⏹ 已取消测试（完成 ' + (msg.results || []).length + ' 个模型）'
        : '🏁 测试完成：✅ 通过 ' + ok + ' / ' + msg.results.length;
      $('test-start').disabled = false;
      $('test-start').textContent = '▶ 再次测试';
    } else {
      const ok = testItems.filter(function (i) { return i.status === 'ok'; }).length;
      const fail = testItems.filter(function (i) { return i.status === 'fail'; }).length;
      $('test-summary').textContent = '⏳ 测试中… 通过 ' + ok + ' / 失败 ' + fail + ' / 共 ' + testItems.length;
    }
  }

  function renderTestResult() {
    const box = $('test-result');
    // 结果自动排序：已通过(ok)按 TPS 降序在前，失败/排队中在后
    const sorted = testItems.slice().sort(function (a, b) {
      const ao = a.status === 'ok' ? 1 : 0, bo = b.status === 'ok' ? 1 : 0;
      if (ao !== bo) return bo - ao;
      if (ao === 1) return (b.tps || 0) - (a.tps || 0);
      return 0;
    });
    renderTestChart();
    box.innerHTML = sorted.map(function (it) {
      const icon = it.status === 'ok' ? '✅' : it.status === 'fail' ? '❌' : '⏳';
      const cls = it.status === 'ok' ? 'ok' : it.status === 'fail' ? 'error' : 'info';
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
      return `<div class="test-row ${cls}"><span class="t-icon">${icon}</span><span class="t-name">${esc(it.name)}</span><span class="t-stat">${esc(stats.filter(Boolean).join(' | '))}</span>${it.audit && it.audit.length ? `<span class="t-audit" data-audit="${esc(it.bundle_id)}" title="参数审计：请求 vs 实际生效">📋</span>` : ''}</div>`;
    }).join('') || '<div class="empty-hint">尚未开始测试。</div>';
  }

  // ── 参数扫描（单模型 × 多参数组合）────────────────
  const SWEEP_PARAMS = [
    { key: 'n_gpu_layers', label: 'GPU 层数', type: 'int', hint: '0=纯CPU；总层数=全部上GPU', def: '0, 16, 33', ph: '如 0, 16, 33',
      presets: [['0,16,33', '小→中→全量'], ['0,33', '纯CPU vs 全量'], ['16,32,33', '逐档上量'], ['0', '仅纯CPU'], ['33', '仅全量上GPU']] },
    { key: 'ctx_size', label: '上下文长度', type: 'int', hint: '越大越慢、越占显存', def: '', ph: '如 512,1024,2048 或更大',
      presets: [['512,1024,2048', '短/中/长'], ['1024,2048,4096', '标准三档'], ['2048,4096,8192', '偏长'], ['4096,8192,16384', '大上下文'], ['8192,16384,32768', '超大'], ['16384,32768,65536', '极限'], ['32768', '固定32K'], ['65536', '固定64K'], ['131072', '固定128K']] },
    { key: 'threads', label: '线程数', type: 'int', hint: '0=自动', def: '', ph: '如 0, 8, 16',
      presets: [['0,8,16', '自动/中/高'], ['4,8,12,16', '逐档'], ['0', '固定自动'], ['8', '固定8'], ['16', '固定16'], ['32', '固定32']] },
    { key: 'batch_size', label: '批大小', type: 'int', hint: '影响预填充速度', def: '', ph: '如 128, 256, 512',
      presets: [['128,256,512', '小/中/大'], ['256,512,1024', '中/大/超大'], ['512,1024,2048', '标准三档'], ['1024,2048,4096', '大三档'], ['2048,4096,8192', '极限'], ['512', '固定512'], ['2048', '固定2048']] },
    { key: 'ubatch_size', label: '微批大小', type: 'int', hint: '预填充实际执行批次', def: '', ph: '如 64, 128, 256',
      presets: [['64,128,256', '小/中/大'], ['128,256', '两档'], ['256,512', '中/大'], ['512', '固定512']] },
    { key: 'cache_type_k', label: 'K 缓存类型', type: 'enum', hint: '量化缓存省显存（需 Flash 注意力）', def: '', ph: '如 f16, q8_0',
      presets: [['f16,q8_0', 'f16 vs 量化'], ['f16,q8_0,q4_0', '三档'], ['q8_0', '固定q8_0'], ['f16', '固定f16'], ['q4_0', '固定q4_0']] },
    { key: 'cache_type_v', label: 'V 缓存类型', type: 'enum', hint: '同 K 缓存', def: '', ph: '如 f16, q8_0',
      presets: [['f16,q8_0', 'f16 vs 量化'], ['f16,q8_0,q4_0', '三档'], ['q8_0', '固定q8_0'], ['f16', '固定f16'], ['q4_0', '固定q4_0']] },
    { key: 'flash_attn', label: 'Flash 注意力', type: 'enum', hint: '量化 KV 需开 FA', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '固定开'], ['off', '固定关']] },
    { key: 'rope_scaling', label: 'RoPE 缩放', type: 'enum', hint: '留空=不设置', def: '', ph: 'linear / yarn',
      presets: [['linear', 'linear 线性'], ['yarn', 'yarn 长上下文'], ['none,linear,yarn', '全部对比'], ['none', '固定不缩放']] },
    { key: 'load_mode', label: '加载模式', type: 'enum', hint: 'mmap 默认快', def: '', ph: 'mmap / mlock',
      presets: [['mmap,mlock', '映射 vs 锁定'], ['mmap', '固定mmap'], ['mlock', '固定mlock']] },
    { key: 'numa', label: 'NUMA', type: 'enum', hint: '多路CPU有效；留空=自动', def: '', ph: 'distribute / isolate',
      presets: [['distribute,isolate', '两种策略'], ['distribute', 'distribute'], ['isolate', 'isolate']] },
    { key: 'kv_unified', label: '统一 KV 缓冲', type: 'bool', hint: 'KV 合并为统一缓冲', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'cache_ram', label: '提示缓存内存(MiB)', type: 'int', hint: '0=禁用', def: '', ph: '如 0, 8192',
      presets: [['0,8192', '禁用 vs 默认'], ['0,4096,8192', '三档'], ['4096,8192,16384', '偏大三档'], ['8192', '固定8192'], ['0', '固定禁用']] },
    { key: 'ctx_checkpoints', label: '上下文检查点', type: 'int', hint: '检查点数量', def: '', ph: '如 16, 32, 64',
      presets: [['16,32,64', '三档'], ['32', '固定32'], ['0,32', '禁用 vs 默认'], ['0', '固定禁用']] },
    { key: 'checkpoint_min_step', label: '检查点最小间隔', type: 'int', hint: '间隔越大越省', def: '', ph: '如 4096, 8192',
      presets: [['4096,8192,16384', '三档'], ['2048,4096,8192', '更密三档'], ['8192', '固定8192']] },
    { key: 'cpu_moe', label: 'MoE 专家驻留 CPU', type: 'bool', hint: 'MoE 专家留在 CPU', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'parallel', label: '并行槽位', type: 'int', hint: '并发请求槽位数', def: '', ph: '如 1, 4, 8',
      presets: [['1,4,8', '低/中/高'], ['4,8', '两档'], ['1', '固定单槽'], ['4', '固定4']] },
    { key: 'main_gpu', label: '主 GPU', type: 'int', hint: '主 GPU 编号（多卡）', def: '', ph: '如 0, 1',
      presets: [['0,1', '两卡对比'], ['0', '固定0'], ['1', '固定1']] },
    { key: 'split_mode', label: '张量拆分', type: 'enum', hint: '多卡拆分方式', def: '', ph: 'layer / row',
      presets: [['layer,row', '两种'], ['layer', '按层'], ['row', '按行']] },
    { key: 'tensor_split', label: '张量分配', type: 'string', hint: '各卡权重比例', def: '', ph: '如 0.5,0.5',
      presets: [['0.5,0.5', '双卡均分'], ['0.7,0.3', '偏重']] },
    { key: 'rope_scale', label: 'RoPE 缩放因子', type: 'float', hint: '上下文外推倍数', def: '', ph: '如 2, 4',
      presets: [['2,4', '两档'], ['2', '2倍'], ['4', '4倍']] },
    { key: 'kv_offload', label: 'KV 卸载 GPU', type: 'bool', hint: 'KV 缓存放 GPU', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'keep', label: '保留初始 token', type: 'int', hint: '长上下文复用', def: '', ph: '如 0, 48',
      presets: [['0,48', '两种'], ['0', '不保留'], ['48', '保留48']] },
    { key: 'cache_reuse', label: 'KV 复用最小块', type: 'int', hint: '块大小', def: '', ph: '如 256, 512',
      presets: [['256,512', '两档'], ['0', '禁用'], ['512', '512']] },
    { key: 'cache_idle_slots', label: '缓存空闲槽位', type: 'bool', hint: '空闲槽位复用', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'context_shift', label: '上下文移位', type: 'bool', hint: '长对话移位', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'threads_batch', label: '批处理线程', type: 'int', hint: '预填充线程', def: '', ph: '如 0, 8, 16',
      presets: [['0,8,16', '三档'], ['0', '跟随'], ['8', '固定8']] },
    { key: 'n_cpu_moe', label: 'CPU 专家数', type: 'int', hint: 'MoE 留 CPU 层数', def: '', ph: '如 0, 4, 8',
      presets: [['0,4,8', '三档'], ['0', '不用'], ['8', '固定8']] },
    { key: 'no_mmproj_offload', label: 'mmproj 走 CPU', type: 'bool', hint: '省显存给主模型', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] },
    { key: 'reasoning_effort', label: '推理努力', type: 'enum', hint: '推理模型思考强度', def: '', ph: 'low / medium / high',
      presets: [['low,medium,high', '三档'], ['medium,high', '两档'], ['low', '低'], ['high', '高']] },
    { key: 'sampler_seq', label: '简化采样序列', type: 'string', hint: '单字符采样链', def: '', ph: '如 edskypmxt',
      presets: [['edskypmxt', '默认链'], ['ekpmxt', '精简']] },
    { key: 'ignore_eos', label: '忽略 EOS', type: 'bool', hint: '不因结束符停止', def: '', ph: 'on / off',
      presets: [['on,off', '开 vs 关'], ['on', '开启'], ['off', '关闭']] }
  ];
  let sweepMode = 'exhaustive'; // exhaustive | greedy
  let sweepItems = [];
  let sweepRunning = false;
  let sweepBest = -1;
  let sweepJobId = null;
  let lastBest = null; // {modelId, params, meta} 最近一次测试的最优配置

  function switchTestTab(name) {
    document.querySelectorAll('#test-tabs .tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    hideStage();
    $('tab-batch').hidden = name !== 'batch';
    $('tab-sweep').hidden = name !== 'sweep';
    $('tab-history').hidden = name !== 'history';
    const isSweep = name === 'sweep';
    $('test-summary').textContent = '';
    $('savecfg-row').hidden = true;
    $('test-savecfg').hidden = !lastBest;
    $('test-start').disabled = false;
    $('test-start').textContent = isSweep ? '▶ 开始扫描' : '▶ 开始测试';
    $('test-cancel').hidden = !(testRunning || sweepRunning);
    if (name === 'history') {
      renderTestHistory();
      return;
    }
    if (isSweep) {
      renderSweepParams();
      document.querySelectorAll('.sweep-modebar .chip').forEach(function (x) { x.classList.toggle('active', x.dataset.smode === sweepMode); });
      $('btn-sweep-fillall').hidden = sweepMode !== 'greedy';
      $('test-start').textContent = sweepMode === 'greedy' ? '▶ 开始寻优' : '▶ 开始扫描';
      updateSweepEstimate();
    } else {
      renderTestResult();
    }
  }

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

  function sweepRowHTML(p) {
    const opts = (p.presets || []).map(function (pr) {
      return '<option value="' + esc(pr[0]) + '">' + esc(pr[1]) + '</option>';
    }).join('');
    const numeric = p.type === 'int' || p.type === 'float';
    const chips = (p.presets || []).map(function (pr) {
      return '<button class="btn tiny me-chip" data-key="' + p.key + '" data-val="' + esc(pr[0]) + '" title="填入: ' + esc(pr[0]) + '">' + esc(pr[1]) + '</button>';
    }).join('');
    return '<span class="sweep-label">' + esc(p.label) + '<i class="sweep-hint">' + esc(p.hint) + '</i></span>' +
      '<span class="sweep-mode" title=""></span>' +
      '<span class="sweep-cap" data-cap="' + p.key + '"></span>' +
      '<input type="text" id="sw-' + p.key + '" data-key="' + p.key + '" value="' + esc(p.def || '') + '" placeholder="' + esc(p.ph || '逗号分隔多个值（多值=扫描，单值=固定）') + '">' +
      '<button class="btn tiny" data-editor="' + p.key + '" title="多值编辑器：范围生成 / 档位选择">📐</button>' +
      '<select class="preset" data-target="sw-' + p.key + '" title="一键填入常用值"><option value="">▾ 预设</option>' + opts + '</select>' +
      '<button class="btn tiny" data-clear="' + p.key + '" title="清空此项">✕</button>' +
      '<div class="multi-editor" id="me-' + p.key + '" hidden>' +
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
      if (!target || presetSel.value === '') return;
      target.value = presetSel.value;
      presetSel.value = '';
      updateSweepEstimate();
    });
    // 多值编辑器：📐 展开/收起
    const edBtn = row.querySelector('[data-editor]');
    if (edBtn) edBtn.addEventListener('click', function () {
      const panel = $('me-' + edBtn.dataset.editor);
      if (panel) panel.hidden = !panel.hidden;
    });
    // 范围生成：min~max:step → 逗号分隔值列表
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
    // 预设 chips：点击填入
    row.querySelectorAll('.me-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        const target = $('sw-' + chip.dataset.key);
        if (target) {
          target.value = chip.dataset.val;
          updateSweepEstimate();
        }
      });
    });
  }

  function addSweepRow(p) {
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
    SWEEP_PARAMS.forEach(function (p) { addSweepRow(p); });
    const ctxRow = box.querySelector('.preset[data-target="sw-ctx_size"]');
    if (ctxRow) fillCtxPreset(ctxRow, mxcOfSweepModel());
    applySweepGrey();
  }

  // ── 动态添加更多可扫参数（从注册表）──────────────
  function loadSweepAddParamOptions() {
    api('/api/params').then(function (res) {
      const list = (res && res.params) || [];
      window.__sweepParams = list;
      const used = {};
      SWEEP_PARAMS.forEach(function (p) { used[p.key] = true; });
      const sel = $('sweep-add-param');
      sel.innerHTML = '<option value="">➕ 添加更多参数…</option>';
      list.forEach(function (pd) {
        if (used[pd.key] || ['int', 'float', 'enum', 'bool'].indexOf(pd.kind) < 0) return;
        const o = document.createElement('option');
        o.value = pd.key;
        o.textContent = pd.label + '（' + pd.key + '）';
        sel.appendChild(o);
      });
    }).catch(function () { /* 忽略加载失败 */ });
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
    if (document.getElementById('sw-' + key)) { flashBtn(sel, '已添加'); return; }
    const pd = (window.__sweepParams || []).find(function (x) { return x.key === key; });
    if (!pd) return;
    const type = sweepKindToType(pd.kind);
    addSweepRow({
      key: key, label: pd.label || key, type: type,
      hint: pd.help || '', def: '', ph: '逗号分隔多个值（多值=扫描，单值=固定）',
      presets: buildPresetsFor(pd, type)
    });
    const opt = Array.prototype.find.call(sel.options, function (o) { return o.value === key; });
    if (opt) opt.remove();
    flashBtn(sel, '✓ 已添加');
  }

  function fmtDur(secs) {
    if (secs < 60) return '约 ' + Math.max(1, Math.round(secs)) + ' 秒';
    if (secs < 3600) return '约 ' + Math.round(secs / 60) + ' 分钟';
    const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return '约 ' + h + ' 小时 ' + m + ' 分钟';
  }

  // 一键给所有参数填入常用档位（智能寻优时全部参与；单值预设项跳过避免误固定）
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

  // ── 场景模式：一键按场景点亮常用扫描参数组合 ──────────────
  const SCENARIOS = {
    speed: { // 🚀 极速：全量上 GPU、高并发、大 batch
      n_gpu_layers: '33', ctx_size: '2048,4096,8192', threads: '16,32',
      batch_size: '1024,2048', flash_attn: 'on', kv_unified: 'on', parallel: '1,4'
    },
    vram: { // 💾 省显存：量化 KV、低 ctx、部分卸载
      n_gpu_layers: '0,16', ctx_size: '1024,2048', cache_type_k: 'q8_0', cache_type_v: 'q8_0',
      flash_attn: 'on', kv_unified: 'on', threads: '8'
    },
    bal: { // ⚖️ 均衡：吞吐与显存兼顾
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

  // ── 动态灰置：按模型元数据置灰不支持的参数 ──────────────
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
    const PER_COMBO_SEC = 15; // 单个组合平均耗时估算（含启动+推理+停止）
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
    let disabled = sweepRunning;
    if (!any) {
      est.textContent = '请至少为一个参数填写数值（多个值=扫描，单个值=固定）。';
      est.className = 'sweep-est warn';
    } else if (sweepMode === 'greedy') {
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
        est.textContent = '⚠️ ' + detail + '（' + dur + '），超过上限 ' + CAP + '。可改用「🔍 智能寻优」模式，或只扫 1-2 个参数。';
        est.className = 'sweep-est warn';
        disabled = true;
      } else {
        est.textContent = detail + '（' + dur + '）' + untouchedTxt;
        est.className = 'sweep-est';
      }
    }
    $('test-start').disabled = disabled;
  }

  function onTestStart() {
    if ($('tab-sweep').hidden) startTest(); else startSweep();
  }

  function startSweep() {
    if (sweepRunning) return;
    const modelId = $('sweep-model').value;
    if (!modelId) { alert('请选择模型'); return; }
    const params = [];
    document.querySelectorAll('#sweep-params input[data-key]').forEach(function (inp) {
      const vals = String(inp.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (vals.length) params.push({ key: inp.dataset.key, values: vals });
    });
    if (!params.length) { alert('请至少为一个参数填写多个值'); return; }
    sweepRunning = true;
    hideStage();
    sweepBest = -1;
    sweepItems = [];
    renderSweepResult();
    const wrap = $('sweep-radar-wrap');
    if (wrap) wrap.hidden = true;
    $('test-start').disabled = true;
    $('test-start').textContent = sweepMode === 'greedy' ? '⏳ 寻优中…' : '⏳ 扫描中…';
    $('test-summary').textContent = sweepMode === 'greedy' ? '🔍 正在智能寻优…' : '🔬 正在扫描…';
    api(API.testSweep, { method: 'POST', body: JSON.stringify({
      model_id: modelId,
      prompt: $('sweep-prompt').value.trim(),
      max_tokens: parseInt($('sweep-max-tokens').value, 10) || 32,
      mode: sweepMode,
      repeats: parseInt($('sp-repeats').value, 10) || 1,
      warmup: $('sp-warmup').checked,
      ctx: parseInt($('sp-ctx').value, 10) || 0,
      params: params
    }) }).then(function (res) {
      sweepJobId = (res && res.job_id) || null;
      if (sweepJobId) $('test-cancel').hidden = false;
      // 用总数预填待测行（仅穷举；智能寻优结果按步骤实时出现）
      if (res && res.total && sweepMode !== 'greedy') {
        const pending = new Array(res.total);
        for (let i = 0; i < res.total; i++) {
          pending[i] = sweepItems[i] || { combo: i, label: '组合 ' + (i + 1), status: 'pending' };
        }
        sweepItems = pending;
        renderSweepResult();
      }
    }).catch(function (e) {
      alert('扫描启动失败: ' + e.message);
      sweepRunning = false;
      $('test-start').disabled = false;
      $('test-start').textContent = sweepMode === 'greedy' ? '▶ 开始寻优' : '▶ 开始扫描';
    });
  }

  // 由 ws.js 推送 sweep_progress / sweep_done 事件驱动
  function updateSweepItem(msg) {
    const isGreedy = msg.mode === 'greedy';
    // 6 阶段状态机事件（无 status 字段 = 纯阶段广播）
    if (msg.stage && msg.status === undefined) { setStage(msg.stage); return; }
    if (msg.type === 'sweep_progress') {
      sweepItems[msg.combo] = {
        combo: msg.combo, label: msg.label, status: msg.status,
        step: msg.step || '', fixed: msg.fixed || '',
        load_ms: msg.load_ms, tps: msg.tps, tokens: msg.tokens, error: msg.error,
        prompt_ps: msg.prompt_ps, prompt_ms: msg.prompt_ms, eval_ms: msg.eval_ms, repeats: msg.repeats,
        cached: msg.cached, vram_gb: msg.vram_gb, audit: msg.audit
      };
      $('test-summary').textContent = isGreedy
        ? '🔍 寻优中… ' + (msg.step || '') + '（' + (msg.combo + 1) + '/' + msg.total + '）'
        : '🔬 扫描中… 已完成 ' + (msg.combo + 1) + ' / ' + msg.total;
    } else if (msg.type === 'sweep_done') {
      sweepRunning = false;
      hideStage();
      $('test-cancel').hidden = true;
      $('test-export').hidden = (msg.results || []).length === 0;
      const ok = (msg.results || []).filter(function (r) { return r.status === 'ok'; }).length;
      let txt;
      if (msg.cancelled) {
        txt = '⏹ 已取消扫描（完成 ' + (msg.results || []).length + ' 次测试）';
      } else if (isGreedy) {
        const tested = msg.tested || 0;
        const reused = (msg.results || []).length - tested;
        txt = '🏁 寻优完成：共测 ' + tested + ' 个不同组合（复用 ' + reused + ' 次缓存），✅ ' + ok + ' 次成功';
        if (msg.best_label) {
          txt += '　最佳 🏆 ' + msg.best_label + (msg.best_tps ? '（' + msg.best_tps.toFixed(1) + ' tok/s）' : '');
        }
        // 提示还有哪些参数未设置（用默认值）
        const unt = [];
        document.querySelectorAll('#sweep-params input[data-key]').forEach(function (inp) {
          const n = String(inp.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).length;
          if (!n) { const p = SWEEP_PARAMS.find(function (x) { return x.key === inp.dataset.key; }); unt.push(p ? p.label : inp.dataset.key); }
        });
        if (unt.length) txt += '　（另有 ' + unt.length + ' 项未设置，用默认值）';
      } else {
        sweepBest = (msg.best != null) ? msg.best : -1;
        txt = '🏁 扫描完成：✅ ' + ok + ' / ' + msg.results.length;
        if (sweepBest >= 0 && msg.results[sweepBest]) {
          const b = msg.results[sweepBest];
          txt += '  最佳 🏆 ' + b.label + '（' + b.tps.toFixed(1) + ' tok/s）';
        }
      }
      $('test-summary').textContent = txt;
      $('test-start').disabled = false;
      $('test-start').textContent = isGreedy ? '▶ 再次寻优' : '▶ 再次扫描';
      if (msg.best_params && !msg.cancelled) {
        lastBest = { modelId: $('sweep-model').value, params: msg.best_params, meta: msg.best_meta || {}, label: msg.best_label || '' };
        $('test-savecfg').hidden = false;
        $('savecfg-row').hidden = true;
      } else {
        $('test-savecfg').hidden = true;
        $('savecfg-row').hidden = true;
      }
      renderSweepRadar();
    }
    renderSweepResult();
  }

  function renderSweepResult() {
    const box = $('sweep-result');
    if (!sweepItems.length) { box.innerHTML = '<div class="empty-hint">尚未开始扫描。</div>'; return; }
    if (sweepMode === 'greedy') {
      // 智能寻优：按步骤分组展示，每步内 🏆 标出该参数最优档
      const groups = [];
      sweepItems.forEach(function (it) {
        if (!it) return;
        let g = groups.find(function (x) { return x.step === it.step; });
        if (!g) { g = { step: it.step, items: [] }; groups.push(g); }
        g.items.push(it);
      });
      box.innerHTML = groups.map(function (g) {
        let best = -1, bestTps = -1;
        g.items.forEach(function (it, i) {
          if (it.status === 'ok' && it.tps > bestTps) { bestTps = it.tps; best = i; }
        });
        const rows = g.items.map(function (it, i) {
          const win = (i === best);
          const icon = win ? '🏆' : it.status === 'ok' ? '✅' : it.status === 'fail' ? '❌' : '⏳';
          const cls = win ? 'ok best' : it.status === 'ok' ? 'ok' : it.status === 'fail' ? 'error' : 'info';
          const stats = [];
          if (it.status === 'ok') {
            stats.push('加载 ' + ((it.load_ms / 1000).toFixed(1)) + 's');
            if (it.prompt_ms) stats.push('首token ' + Math.round(it.prompt_ms) + 'ms');
            if (it.tps) stats.push(it.tps.toFixed(1) + ' tok/s');
            stats.push(it.tokens + ' tok');
            if (it.vram_gb) stats.push('显存 ' + it.vram_gb.toFixed(1) + 'GB');
            if (it.repeats > 1) stats.push('×' + it.repeats + '次');
            if (it.cached) stats.push('⚡复用');
          } else if (it.status === 'fail') stats.push(it.error || '失败');
          else stats.push('启动中…');
          const auditBtn = (it.audit && it.audit.length) ? '<span class="t-audit" data-audit="' + it.combo + '" title="参数审计：请求 vs 实际生效">📋</span>' : '';
          return '<div class="test-row ' + cls + '"><span class="t-icon">' + icon + '</span><span class="t-name">' + esc(it.label || '') + '</span><span class="t-stat">' + esc(stats.filter(Boolean).join(' | ')) + '</span>' + auditBtn + '</div>';
        }).join('');
        return '<div class="sweep-group">' + (g.step ? '<div class="sweep-step">' + esc(g.step) + '</div>' : '') + rows + '</div>';
      }).join('');
      renderSweepChart();
      return;
    }
    box.innerHTML = sweepItems.map(function (it, i) {
      if (!it) return '';
      const icon = it.status === 'ok' ? (i === sweepBest ? '🏆' : '✅') : it.status === 'fail' ? '❌' : '⏳';
      const cls = it.status === 'ok' ? (i === sweepBest ? 'ok best' : 'ok') : it.status === 'fail' ? 'error' : 'info';
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
      const auditBtn = (it.audit && it.audit.length) ? '<span class="t-audit" data-audit="' + it.combo + '" title="参数审计：请求 vs 实际生效">📋</span>' : '';
      return '<div class="test-row ' + cls + '"><span class="t-icon">' + icon + '</span><span class="t-name">' + esc(it.label || ('组合 ' + i)) + '</span><span class="t-stat">' + esc(stats.filter(Boolean).join(' | ')) + '</span>' + auditBtn + '</div>';
    }).join('');
    renderSweepChart();
  }

  // ── 测试结果图表 / 取消 / 导出 / 历史 ─────────────────────
  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function renderTestChart() {
    const el = $('test-chart');
    if (!el || typeof echarts === 'undefined') return;
    const ok = testItems.filter(function (i) { return i.status === 'ok' && i.tps; })
      .sort(function (a, b) { return (b.tps || 0) - (a.tps || 0); });
    if (!ok.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    if (!window.__testChart) window.__testChart = echarts.init(el);
    const colors = ['#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#f44336', '#8bc34a', '#3f51b5'];
    window.__testChart.setOption({
      title: { text: '吞吐对比（tok/s，越高越快）', left: 'center', textStyle: { fontSize: 12 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 50, right: 16, bottom: 28, top: 34 },
      xAxis: { type: 'category', data: ok.map(function (i) { return truncate(i.name, 16); }), axisLabel: { fontSize: 10, rotate: 20 } },
      yAxis: { type: 'value', name: 'tok/s', nameTextStyle: { fontSize: 10 } },
      series: [{
        type: 'bar', barMaxWidth: 40,
        data: ok.map(function (i, idx) { return { value: +(i.tps.toFixed(1)), itemStyle: { color: colors[idx % colors.length] } }; }),
        label: { show: true, position: 'top', fontSize: 10 }
      }]
    }, true);
  }

  function sweepMetric() {
    const sel = $('sweep-chart-metric');
    return sel ? sel.value : 'tps';
  }
  function renderSweepChart() {
    const el = $('sweep-chart');
    if (!el || typeof echarts === 'undefined') return;
    const metric = sweepMetric();
    const wrap = el.closest('.test-chart');
    if (metric === 'pareto') { renderParetoChart(el, wrap); return; }
    const pick = function (it) {
      if (metric === 'prompt_ms') return it.prompt_ms || 0;
      if (metric === 'load_ms') return it.load_ms || 0;
      return it.tps || 0;
    };
    const lower = metric !== 'tps'; // 延迟/加载越低越好
    const ok = sweepItems.filter(function (i) { return i && i.status === 'ok' && pick(i) > 0; })
      .sort(function (a, b) { return lower ? (pick(a) - pick(b)) : (pick(b) - pick(a)); });
    if (!ok.length) { if (wrap) wrap.hidden = true; return; }
    if (wrap) wrap.hidden = false;
    if (!window.__sweepChart) window.__sweepChart = echarts.init(el);
    const names = { tps: '吞吐 tok/s（橙=最高）', prompt_ms: '首 token 延迟 ms（橙=最低）', load_ms: '加载时间 ms（橙=最低）' };
    const unit = { tps: 'tok/s', prompt_ms: 'ms', load_ms: 'ms' }[metric];
    window.__sweepChart.setOption({
      title: { text: '各组合对比 · ' + names[metric], left: 'center', textStyle: { fontSize: 12 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 50, right: 16, bottom: 44, top: 34 },
      xAxis: { type: 'category', data: ok.map(function (i) { return truncate(i.label || '', 12); }), axisLabel: { fontSize: 9, rotate: 35 } },
      yAxis: { type: 'value', name: unit, nameTextStyle: { fontSize: 10 } },
      series: [{
        type: 'bar', barMaxWidth: 26,
        data: ok.map(function (i, idx) { return { value: +(pick(i).toFixed(1)), itemStyle: { color: idx === 0 ? '#ff9800' : '#2196f3' } }; }),
        label: { show: true, position: 'top', fontSize: 9 }
      }]
    }, true);
  }

  // 🎯 帕累托前沿图（X 显存 GB × Y 速度 tok/s）
  function renderParetoChart(el, wrap) {
    const pts = sweepItems.filter(function (i) { return i && i.status === 'ok' && i.tps && i.vram_gb > 0; })
      .map(function (i) { return { x: i.vram_gb, y: i.tps, label: i.label || '' }; });
    if (!pts.length) { if (wrap) wrap.hidden = true; return; }
    if (wrap) wrap.hidden = false;
    if (!window.__sweepChart) window.__sweepChart = echarts.init(el);
    // 帕累托前沿：按显存升序，只有比此前所有点都更快（严格更高 TPS）的点才是前沿
    const sorted = pts.slice().sort(function (a, b) { return a.x - b.x; });
    const frontier = [];
    let bestY = -1;
    sorted.forEach(function (p) {
      if (p.y > bestY) { bestY = p.y; frontier.push(p); }
    });
    window.__sweepChart.setOption({
      title: { text: '🎯 帕累托前沿（显存 GB × 吞吐）', left: 'center', textStyle: { fontSize: 12 } },
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          if (p.seriesIndex === 1) return '前沿 ' + p.data.label + '<br/>显存 ' + p.data.x.toFixed(1) + ' GB · ' + p.data.y.toFixed(1) + ' tok/s';
          return p.data.label + '<br/>显存 ' + p.data.x.toFixed(1) + ' GB · ' + p.data.y.toFixed(1) + ' tok/s';
        }
      },
      legend: { bottom: 0, data: ['组合', '前沿'] },
      grid: { left: 55, right: 22, bottom: 40, top: 34 },
      xAxis: { type: 'value', name: '显存 GB', nameTextStyle: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'tok/s', nameTextStyle: { fontSize: 10 } },
      series: [
        {
          name: '组合', type: 'scatter', symbolSize: 11,
          data: pts.map(function (p) { return { value: [p.x, p.y], label: p.label }; }),
          itemStyle: { color: '#2196f3', opacity: 0.75 }
        },
        {
          name: '前沿', type: 'line', smooth: true, symbolSize: 9,
          data: frontier.map(function (p) { return { value: [p.x, p.y], label: p.label }; }),
          lineStyle: { color: '#ff9800', width: 2 },
          itemStyle: { color: '#ff9800' }
        }
      ]
    }, true);
  }

  // 🕸 性能雷达图（最优 vs 平均，TPS/首token延迟/加载/显存 4 维归一化越高越好）
  function renderSweepRadar() {
    const wrap = $('sweep-radar-wrap');
    const el = $('sweep-radar');
    if (!wrap || !el || typeof echarts === 'undefined') return;
    const ok = sweepItems.filter(function (i) { return i && i.status === 'ok' && i.tps; });
    if (!ok.length) { wrap.hidden = true; return; }
    let best = ok[0];
    ok.forEach(function (i) { if (i.tps > best.tps) best = i; });
    const dims = [
      { key: 'tps', name: '吞吐', higher: true },
      { key: 'prompt_ms', name: '首token延迟', higher: false },
      { key: 'load_ms', name: '加载', higher: false },
      { key: 'vram_gb', name: '显存', higher: false }
    ];
    const val = function (it, key) {
      if (key === 'tps') return it.tps || 0;
      if (key === 'prompt_ms') return it.prompt_ms || 0;
      if (key === 'load_ms') return it.load_ms || 0;
      return it.vram_gb || 0;
    };
    const mm = {};
    dims.forEach(function (d) {
      let mn = Infinity, mx = -Infinity;
      ok.forEach(function (it) { const v = val(it, d.key); if (v < mn) mn = v; if (v > mx) mx = v; });
      mm[d.key] = { mn: mn, mx: mx };
    });
    const norm = function (it, d) {
      const m = mm[d.key];
      if (m.mx === m.mn) return 1;
      const r = (val(it, d.key) - m.mn) / (m.mx - m.mn);
      return d.higher ? r : 1 - r;
    };
    const avg = {};
    dims.forEach(function (d) { avg[d.key] = 0; });
    ok.forEach(function (it) { dims.forEach(function (d) { avg[d.key] += val(it, d.key); }); });
    dims.forEach(function (d) { avg[d.key] /= ok.length; });
    const avgVals = dims.map(function (d) {
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
      radar: { indicator: dims.map(function (d) { return { name: d.name, max: 1 }; }), radius: '60%' },
      series: [{
        type: 'radar',
        data: [
          { name: bestName, value: dims.map(function (d) { return +norm(best, d).toFixed(2); }), areaStyle: { color: 'rgba(76,175,80,0.30)' }, lineStyle: { color: '#4caf50' }, itemStyle: { color: '#4caf50' } },
          { name: '平均', value: avgVals.map(function (v) { return +v.toFixed(2); }), areaStyle: { color: 'rgba(33,150,243,0.18)' }, lineStyle: { color: '#2196f3' }, itemStyle: { color: '#2196f3' } }
        ]
      }]
    }, true);
    wrap.hidden = false;
  }

  // ── 6 阶段状态机（validating→auditing→warming_up→benchmarking→cleaning）──
  const STAGES = ['queued', 'validating', 'auditing', 'warming_up', 'benchmarking', 'cleaning'];
  function setStage(stage) {
    const bar = $('stage-bar');
    if (!bar || !stage || STAGES.indexOf(stage) < 0) return;
    bar.hidden = false;
    const cur = STAGES.indexOf(stage);
    bar.querySelectorAll('.stage-chip').forEach(function (chip) {
      const idx = STAGES.indexOf(chip.dataset.stage);
      chip.classList.toggle('active', idx === cur);
      chip.classList.toggle('done', idx < cur);
    });
  }
  function hideStage() {
    const bar = $('stage-bar');
    if (bar) bar.hidden = true;
  }

  // 📋 参数审计表（请求 vs 实际生效）
  function auditTableHTML(audit) {
    if (!audit || !audit.length) return '';
    const rows = audit.map(function (a) {
      const icon = a.same ? '✅' : '⚠️';
      return '<tr class="' + (a.same ? 'same' : 'diff') + '"><td>' + esc(a.label || a.key) + '</td><td>' + esc(a.requested || '—') + '</td><td>' + esc(a.effective || '—') + '</td><td>' + icon + ' ' + esc(a.note || '') + '</td></tr>';
    }).join('');
    return '<div class="audit-box"><table class="audit-table"><thead><tr><th>参数</th><th>请求</th><th>实际生效</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function cancelTestRun() {
    const jobId = $('tab-sweep').hidden ? testJobId : sweepJobId;
    if (!jobId) return;
    api(API.testCancel, { method: 'POST', body: JSON.stringify({ job_id: jobId }) }).then(function () {
      flashBtn($('test-cancel'), '已请求取消…');
      $('test-cancel').disabled = true;
    });
  }

  function exportTestReport() {
    const isSweep = !$('tab-sweep').hidden;
    const rows = isSweep
      ? [['组合', '状态', '加载(ms)', '吞吐(tok/s)', '生成(tok)', '错误']]
      : [['模型', '状态', '加载(ms)', '吞吐(tok/s)', '生成(tok)', '错误']];
    const items = isSweep ? sweepItems : testItems;
    items.forEach(function (it) {
      if (!it) return;
      rows.push([it.label || it.name || '', it.status, it.load_ms || 0, it.tps ? it.tps.toFixed(2) : '', it.tokens || 0, it.error || '']);
    });
    const csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (isSweep ? 'sweep_' : 'test_') + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderTestHistory() {
    const box = $('test-history-list');
    if (!box) return;
    api(API.testHistory).then(function (res) {
      const list = (res && res.records) || [];
      if (!list.length) { box.innerHTML = '<div class="empty-hint">暂无测试历史。完成一次测试/扫描后会记录到这里。</div>'; return; }
      box.innerHTML = list.map(function (rec) {
        const icon = rec.type === 'sweep' ? '🔬' : '🖥';
        const sub = rec.type === 'sweep'
          ? (rec.mode === 'greedy' ? '🔍 智能寻优' : '🔬 参数扫描') + ' · ' + (rec.model || '')
          : '';
        const items = (rec.items || []).slice(0, 15).map(function (it) {
          const cls = it.status === 'ok' ? 'ok' : 'err';
          const txt = it.name + (it.status === 'ok'
            ? ' → ' + (it.tps ? it.tps.toFixed(1) + ' tok/s · ' : '') + Math.round((it.load_ms || 0) / 1000) + 's'
            : ' → ' + (it.error || it.status));
          return '<div class="test-hist-item ' + cls + '">' + esc(txt) + '</div>';
        }).join('');
        const more = (rec.items || []).length > 15 ? '<div class="test-hist-more">… 共 ' + rec.items.length + ' 项</div>' : '';
        return '<div class="test-hist-card">' +
          '<div class="test-hist-head"><span>' + icon + ' <b>' + esc(rec.time) + '</b></span>' +
          '<span class="test-hist-sub">' + esc(rec.summary || '') + (sub ? '　·　' + esc(sub) : '') + '</span>' +
          '<button class="btn tiny test-hist-export" data-id="' + esc(rec.id) + '" title="导出该条为 CSV">📥</button></div>' +
          items + more + '</div>';
      }).join('');
      box.querySelectorAll('.test-hist-export').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const rec = list.find(function (x) { return x.id === btn.dataset.id; });
          if (rec) exportHistoryRecord(rec);
        });
      });
    }).catch(function () { box.innerHTML = '<div class="empty-hint">加载历史失败。</div>'; });
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

  // 点击 💾 → 显示命名行（内嵌浏览器不支持 prompt，改用弹窗内输入框）
  function saveBestConfig() {
    if (!lastBest) return;
    const m = lastBest.meta || {};
    const bits = [];
    if (m.ctx_size) bits.push(m.ctx_size + ' ctx');
    if (m.n_gpu_layers !== undefined && m.n_gpu_layers !== null) bits.push('GPU' + m.n_gpu_layers);
    if (m.tps) bits.push(m.tps.toFixed(1) + ' tok/s');
    if (m.mode === 'greedy') bits.push('寻优');
    $('savecfg-name').value = '🏆 ' + (bits.join(' · ') || '最优配置');
    $('test-savecfg').hidden = true;
    $('savecfg-row').hidden = false;
    $('savecfg-name').focus();
    $('savecfg-name').select();
  }

  function saveConfigNow() {
    if (!lastBest) { $('savecfg-row').hidden = true; $('test-savecfg').hidden = false; return; }
    const name = $('savecfg-name').value.trim() || '最优配置';
    const btn = $('savecfg-confirm');
    btn.disabled = true;
    api('/api/bundles/' + lastBest.modelId + '/configs', {
      method: 'POST',
      body: JSON.stringify({ name: name, params: lastBest.params, meta: lastBest.meta })
    }).then(function () {
      $('savecfg-row').hidden = true;
      $('test-savecfg').hidden = false;
      btn.disabled = false;
      flashBtn(btn, '✓ 已保存');
      refreshBundles();
    }).catch(function () {
      btn.disabled = false;
      flashBtn(btn, '✗ 失败');
    });
  }

  // 把参数对象填入主表单（复选框/数值/下拉通用）
  function applyParamsToForm(params) {
    Object.keys(params || {}).forEach(function (k) {
      const el = $('p-' + k);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!params[k];
      else el.value = params[k];
    });
  }

  // 一键把测试配置填入启动参数并选中该模型（模型库抽屉用）
  function applyTestConfig(bundleId, cfgId) {
    const b = bundles.find(function (x) { return x.id === bundleId; });
    if (!b) return;
    const c = (b.test_configs || []).find(function (x) { return x.id === cfgId; });
    if (!c) return;
    $('model-select').value = bundleId;
    onModelChange();
    applyParamsToForm(c.params || {});
    refreshPreview();
    runAudit();
    closeLibrary();
    flashBtn($('btn-apply-config'), '✓ 已套用');
  }

  // 主面板「🧪 测试配置」下拉套用当前所选配置
  function applySelectedConfig() {
    const b = bundles.find(function (x) { return x.id === selectedId; });
    if (!b) return;
    const c = (b.test_configs || []).find(function (x) { return x.id === $('test-config-select').value; });
    if (!c) return;
    applyParamsToForm(c.params || {});
    refreshPreview();
    runAudit();
    flashBtn($('btn-apply-config'), '✓ 已套用');
  }

  function deleteTestConfig(bundleId, cfgId) {
    if (!confirm('删除该测试配置？')) return;
    api('/api/bundles/' + bundleId + '/configs/' + cfgId, { method: 'DELETE' })
      .then(refreshBundles)
      .catch(function (e) { alert('删除失败: ' + e.message); });
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

  window.TestBatch = { update: updateTestItem, updateSweep: updateSweepItem };

  document.addEventListener('DOMContentLoaded', init);
})();

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
    configGet: '/api/config',
    configPut: '/api/config',
    configKey: '/api/config/key',
    fsList: '/api/fs/list',
    parse: '/api/parse',
    preview: '/api/preview',
    params: '/api/params',
    testBatch: '/api/test/batch',
    testSweep: '/api/test/sweep'
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
    $('btn-library').addEventListener('click', openLibrary);
    $('btn-debug').addEventListener('click', openDebugModal);
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
    $('sweep-model').addEventListener('change', function () {
      const selId = this.value;
      const sb = bundles.find(function (x) { return x.id === selId; });
      const mxc = sb ? Number(((sb.base_model || {}).metadata || {}).context_length || 0) : 0;
      const sel = $('sw-ctx_size') ? $('sw-ctx_size').closest('.sweep-row').querySelector('.preset') : null;
      fillCtxPreset(sel, mxc);
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

    // 弹窗关闭
    document.querySelectorAll('.modal-overlay').forEach(function (ov) {
      ov.querySelectorAll('[data-close]').forEach(function (btn) {
        btn.addEventListener('click', function () { ov.hidden = true; });
      });
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.hidden = true; });
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
      meta.textContent = '📷 视觉: — | ⚡ 草稿: 未启用 | 🏷️ 标签: —';
      $('cfg-row-configs').hidden = true;
      return;
    }
    const vis = (b.mmproj && b.mmproj.path) ? '已绑定' : '未绑定';
    const draft = (b.draft_model && b.draft_model.enabled) ? b.draft_model.spec_type : '未启用';
    const mcp = (b.mcp_servers && b.mcp_servers.length) ? b.mcp_servers.join(', ') : '无';
    meta.textContent = `📷 视觉: ${vis} | ⚡ 草稿: ${draft} | 🧩 MCP: ${mcp} | 🏷️ 标签: ${(b.tags || []).join(', ') || '—'}`;

    // mmproj 字段提示自动检测路径（留空=自动）
    const mmEl = $('p-mmproj');
    if (mmEl) mmEl.placeholder = (b.mmproj && b.mmproj.path) ? '自动: ' + b.mmproj.path : '未检测到 mmproj，可手动填写';

    // MTP 投机解码组：仅当模型是 MTP 变体（文件名含 mtp 或带 mtp 标签）时显示
    const isMtp = (b.name || '').toLowerCase().includes('mtp') ||
      ((b.base_model || {}).path || '').toLowerCase().includes('mtp') ||
      (b.tags || []).includes('mtp');
    const mtpGroup = $('cfg-group-mtp');
    if (mtpGroup) mtpGroup.hidden = !isMtp;

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
        const notes = (rec.notes || []).join('；');
        alert('✨ 一键优化完成\n\n' +
          'GPU 层数: ' + (rec.n_gpu_layers === -1 ? 'auto（全量卸载）' : rec.n_gpu_layers) +
          '\n上下文: ' + rec.ctx_size +
          '\n估算显存: ' + (rec.estimated_vram_gb || 0).toFixed(1) + ' GB' +
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

  // ── 命令预览 ──────────────────────────
  function collectParams() {
    const p = {};
    ['n_gpu_layers', 'ctx_size', 'threads', 'batch_size', 'flash_attn', 'cache_type_k',
     'cache_type_v', 'rope_scaling', 'rope_scale', 'mmproj', 'parallel', 'embedding', 'rerank',
     'cache_ram', 'ctx_checkpoints', 'checkpoint_min_step', 'kv_unified', 'threads_http',
     'metrics', 'props', 'repeat_penalty', 'presence_penalty', 'frequency_penalty',
     'temperature', 'top_p', 'top_k', 'min_p', 'samplers', 'seed', 'load_mode', 'numa',
     'host', 'port', 'api_key'].forEach(function (k) {
      const el = $('p-' + k);
      if (!el) return;
      if (el.type === 'checkbox') { p[k] = el.checked; return; }
      const v = el.value.trim();
      if (v !== '') {
        p[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
      }
    });
    p.cpu_moe = $('p-cpu_moe').checked;
    // MTP 投机解码：勾选 = draft-mtp（用主模型自带 MTP 头），仅勾选时收集草稿参数
    const mtp = $('p-spec_type');
    if (mtp && mtp.checked) {
      p.spec_type = 'draft-mtp';
      ['n_gpu_layers_draft', 'spec_draft_threads', 'spec_draft_n_max', 'spec_draft_n_min',
       'spec_draft_p_split', 'spec_draft_p_min'].forEach(function (k) {
        const el = $('p-' + k);
        if (!el) return;
        const v = el.value.trim();
        if (v !== '') p[k] = /^-?\d+(\.\d+)?$/.test(v) ? (v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10)) : v;
      });
    }
    return p;
  }

  function refreshPreview() {
    const params = collectParams();
    // Use the real model file path (not the bundle id) in the preview.
    const b = bundles.find(x => x.id === selectedId);
    params.model = b && b.base_model ? b.base_model.path : '';
    api(API.preview, { method: 'POST', body: JSON.stringify({ params: params }) })
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

  // ── MCP 服务器管理 ────────────────────
  function openMCPModal() {
    $('mcp-modal').hidden = false;
    loadMCP();
  }

  function loadMCP() {
    const box = $('mcp-list');
    box.innerHTML = '<div class="empty-hint">加载中…</div>';
    api(API.mcpList).then(function (list) {
      renderMCPList(list);
    }).catch(function (e) { box.innerHTML = `<div class="audit-item error">🔴 ${esc(e.message)}</div>`; });
  }

  function renderMCPList(list) {
    const box = $('mcp-list');
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint">尚未注册任何 MCP 服务器。可注册如 filesystem / memory / fetch 等工具服务器。</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (s) {
      const div = document.createElement('div');
      div.className = 'scan-item';
      div.innerHTML = `
        <div>
          <div class="name">${esc(s.name)} ${s.enabled ? '' : '(停用)'}</div>
          <div class="meta">命令: ${esc(s.command)} ${esc((s.args || []).join(' '))}</div>
          <div class="actions" style="margin-top:6px;display:flex;gap:6px">
            <button class="btn small" data-del="${esc(s.id)}">🗑 删除</button>
          </div>
        </div>`;
      div.querySelector('[data-del]').addEventListener('click', function () {
        if (!confirm('删除 MCP 服务器 "' + s.name + '"？')) return;
        api('/api/mcp/' + s.id, { method: 'DELETE' }).then(loadMCP);
      });
      box.appendChild(div);
    });
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
    testItems = ids.map(function (id) { return { bundle_id: id, name: '排队中…', status: 'pending' }; });
    renderTestResult();
    $('test-start').disabled = true;
    $('test-start').textContent = '⏳ 测试中…';
    $('test-summary').textContent = '共 ' + ids.length + ' 个模型，正在逐个测试…';
    api(API.testBatch, { method: 'POST', body: JSON.stringify({
      bundle_ids: ids,
      prompt: $('test-prompt').value.trim(),
      max_tokens: parseInt($('test-max-tokens').value, 10) || 16
    }) }).catch(function (e) { alert('测试启动失败: ' + e.message); testRunning = false; });
  }

  // 由 ws.js 推送 test_progress / test_done 事件驱动
  function updateTestItem(msg) {
    const it = testItems.find(function (i) { return i.bundle_id === msg.bundle_id; });
    if (it) {
      it.name = msg.name || it.name;
      it.status = msg.status;
      it.load_ms = msg.load_ms;
      it.tps = msg.tps;
      it.tokens = msg.tokens;
      it.error = msg.error;
    }
    renderTestResult();
    if (msg.type === 'test_done') {
      testRunning = false;
      const ok = (msg.results || []).filter(function (r) { return r.status === 'ok'; }).length;
      $('test-summary').textContent = '🏁 测试完成：✅ 通过 ' + ok + ' / ' + msg.results.length;
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
    box.innerHTML = testItems.map(function (it) {
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
      return `<div class="test-row ${cls}"><span class="t-icon">${icon}</span><span class="t-name">${esc(it.name)}</span><span class="t-stat">${esc(stats.filter(Boolean).join(' | '))}</span></div>`;
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
      presets: [['1,4,8', '低/中/高'], ['4,8', '两档'], ['1', '固定单槽'], ['4', '固定4']] }
  ];
  let sweepMode = 'exhaustive'; // exhaustive | greedy
  let sweepItems = [];
  let sweepRunning = false;
  let sweepBest = -1;
  let lastBest = null; // {modelId, params, meta} 最近一次测试的最优配置

  function switchTestTab(name) {
    document.querySelectorAll('#test-tabs .tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    $('tab-batch').hidden = name !== 'batch';
    $('tab-sweep').hidden = name !== 'sweep';
    const isSweep = name === 'sweep';
    $('test-summary').textContent = '';
    $('savecfg-row').hidden = true;
    $('test-savecfg').hidden = !lastBest;
    $('test-start').disabled = false;
    $('test-start').textContent = isSweep ? '▶ 开始扫描' : '▶ 开始测试';
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

  function renderSweepParams() {
    const box = $('sweep-params');
    box.innerHTML = '';
    SWEEP_PARAMS.forEach(function (p) {
      const row = document.createElement('div');
      row.className = 'sweep-row';
      const opts = (p.presets || []).map(function (pr) {
        return '<option value="' + esc(pr[0]) + '">' + esc(pr[1]) + '</option>';
      }).join('');
      row.innerHTML =
        '<span class="sweep-label">' + esc(p.label) + '<i class="sweep-hint">' + esc(p.hint) + '</i></span>' +
        '<span class="sweep-mode" title=""></span>' +
        '<input type="text" id="sw-' + p.key + '" data-key="' + p.key + '" value="' + esc(p.def) + '" placeholder="' + esc(p.ph) + '">' +
        '<select class="preset" data-target="sw-' + p.key + '" title="一键填入常用值"><option value="">▾ 预设</option>' + opts + '</select>' +
        '<button class="btn tiny" data-clear="' + p.key + '" title="清空此项">✕</button>';
      box.appendChild(row);
    });
    box.querySelectorAll('input[data-key]').forEach(function (inp) {
      inp.addEventListener('input', updateSweepEstimate);
    });
    box.querySelectorAll('[data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $('sw-' + btn.dataset.clear).value = '';
        updateSweepEstimate();
      });
    });
    // 预设下拉 → 一键填入常用值并刷新组合数
    box.querySelectorAll('.preset[data-target]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        const target = $(sel.dataset.target);
        if (!target || sel.value === '') return;
        target.value = sel.value;
        sel.value = '';
        updateSweepEstimate();
      });
    });
    // 上下文预设随所选模型的最大上下文动态生成
    const sm = $('sweep-model');
    const sb = bundles.find(function (x) { return x.id === sm.value; });
    const mxc = sb ? Number(((sb.base_model || {}).metadata || {}).context_length || 0) : 0;
    fillCtxPreset(box.querySelector('.preset[data-target="sw-ctx_size"]'), mxc);
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
      if (n === 0) {
        if (tag) { tag.textContent = ''; tag.title = '不参与（用默认值）'; }
        untouched.push(lbl);
        return;
      }
      any = true;
      if (n > 1) {
        total *= n;
        tests += n;
        swept.push(lbl + '(' + vals.join('/') + ')');
        if (tag) { tag.textContent = '🔀'; tag.title = '扫描 ' + n + ' 档'; }
      } else {
        fixed.push(lbl + '=' + vals[0]);
        if (tag) { tag.textContent = '📌'; tag.title = '固定 ' + vals[0] + '，用于每个组合'; }
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
    sweepBest = -1;
    sweepItems = [];
    renderSweepResult();
    $('test-start').disabled = true;
    $('test-start').textContent = sweepMode === 'greedy' ? '⏳ 寻优中…' : '⏳ 扫描中…';
    $('test-summary').textContent = sweepMode === 'greedy' ? '🔍 正在智能寻优…' : '🔬 正在扫描…';
    api(API.testSweep, { method: 'POST', body: JSON.stringify({
      model_id: modelId,
      prompt: $('sweep-prompt').value.trim(),
      max_tokens: parseInt($('sweep-max-tokens').value, 10) || 16,
      mode: sweepMode,
      params: params
    }) }).then(function (res) {
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
    if (msg.type === 'sweep_progress') {
      sweepItems[msg.combo] = {
        combo: msg.combo, label: msg.label, status: msg.status,
        step: msg.step || '', fixed: msg.fixed || '',
        load_ms: msg.load_ms, tps: msg.tps, tokens: msg.tokens, error: msg.error
      };
      $('test-summary').textContent = isGreedy
        ? '🔍 寻优中… ' + (msg.step || '') + '（' + (msg.combo + 1) + '/' + msg.total + '）'
        : '🔬 扫描中… 已完成 ' + (msg.combo + 1) + ' / ' + msg.total;
    } else if (msg.type === 'sweep_done') {
      sweepRunning = false;
      const ok = (msg.results || []).filter(function (r) { return r.status === 'ok'; }).length;
      let txt;
      if (isGreedy) {
        txt = '🏁 寻优完成：共测 ' + (msg.results || []).length + ' 次，✅ ' + ok + ' 次成功';
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
      if (msg.best_params) {
        lastBest = { modelId: $('sweep-model').value, params: msg.best_params, meta: msg.best_meta || {}, label: msg.best_label || '' };
        $('test-savecfg').hidden = false;
        $('savecfg-row').hidden = true;
      } else {
        $('test-savecfg').hidden = true;
        $('savecfg-row').hidden = true;
      }
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
            if (it.tps) stats.push(it.tps.toFixed(1) + ' tok/s');
            stats.push(it.tokens + ' tok');
          } else if (it.status === 'fail') stats.push(it.error || '失败');
          else stats.push('启动中…');
          return '<div class="test-row ' + cls + '"><span class="t-icon">' + icon + '</span><span class="t-name">' + esc(it.label || '') + '</span><span class="t-stat">' + esc(stats.filter(Boolean).join(' | ')) + '</span></div>';
        }).join('');
        return '<div class="sweep-group">' + (g.step ? '<div class="sweep-step">' + esc(g.step) + '</div>' : '') + rows + '</div>';
      }).join('');
      return;
    }
    box.innerHTML = sweepItems.map(function (it, i) {
      if (!it) return '';
      const icon = it.status === 'ok' ? (i === sweepBest ? '🏆' : '✅') : it.status === 'fail' ? '❌' : '⏳';
      const cls = it.status === 'ok' ? (i === sweepBest ? 'ok best' : 'ok') : it.status === 'fail' ? 'error' : 'info';
      const stats = [];
      if (it.status === 'ok') {
        stats.push('加载 ' + ((it.load_ms / 1000).toFixed(1)) + 's');
        if (it.tps) stats.push(it.tps.toFixed(1) + ' tok/s');
        stats.push(it.tokens + ' tok');
      } else if (it.status === 'fail') {
        stats.push(it.error || '失败');
      } else {
        stats.push('启动中…');
      }
      return '<div class="test-row ' + cls + '"><span class="t-icon">' + icon + '</span><span class="t-name">' + esc(it.label || ('组合 ' + i)) + '</span><span class="t-stat">' + esc(stats.filter(Boolean).join(' | ')) + '</span></div>';
    }).join('');
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

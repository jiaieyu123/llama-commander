// charts.js — 基于 ECharts 的性能监控图表（离线时优雅降级）
(function () {
  'use strict';

  let chart = null;
  const chartEl = document.getElementById('tps-chart');
  const tpsData = [];

  function init() {
    if (typeof echarts === 'undefined' || !chartEl) return; // 离线降级
    chart = echarts.init(chartEl, null, { renderer: 'canvas' });
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      grid: { left: 44, right: 16, top: 16, bottom: 24 },
      xAxis: { type: 'category', data: [], axisLine: { lineStyle: { color: '#2a3242' } } },
      yAxis: { type: 'value', name: 'tok/s', splitLine: { lineStyle: { color: '#1c2230' } } },
      series: [{
        name: '吞吐', type: 'line', smooth: true, showSymbol: false,
        lineStyle: { color: '#4f8cff', width: 2 },
        areaStyle: { color: 'rgba(79,140,255,.12)' },
        data: []
      }]
    });
    window.addEventListener('resize', () => chart && chart.resize());
  }

  // 追加一个吞吐采样点
  function pushTps(tps) {
    if (typeof tps !== 'number' || !isFinite(tps)) return;
    tpsData.push(tps);
    if (tpsData.length > 120) tpsData.shift();
    if (!chart) return;
    chart.setOption({
      xAxis: { data: tpsData.map((_, i) => formatTime(i)) },
      series: [{ data: tpsData }]
    });
  }

  function formatTime(idx) {
    const t = new Date(Date.now() - (tpsData.length - 1 - idx) * 5000);
    return t.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function reset() {
    tpsData.length = 0;
    if (chart) chart.setOption({ xAxis: { data: [] }, series: [{ data: [] }] });
  }

  window.PerfChart = { init: init, pushTps: pushTps, reset: reset };
})();

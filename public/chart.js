// Two-series "with vs without Phase 1" comparison chart. Plain SVG, no
// dependency — palette validated against the app's dark result-card surface
// (#3D4347): yellow (existing brand accent, "with Phase 1") + teal (new,
// "without Phase 1" baseline) pass chroma/CVD-separation/contrast checks.
// The brand yellow itself sits outside the ideal dark-mode lightness band,
// but it's a fixed, already-shipped brand color on a medium-dark card, not a
// free parameter — accepted as a deliberate exception.
const CHART_COLORS = {
  withPhase1: '#FEE116',
  withoutPhase1: '#5FD1C5',
};

function niceStep(maxValue) {
  if (maxValue <= 0) return 1;
  const rough = maxValue / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  let step;
  if (normalized < 1.5) step = 1;
  else if (normalized < 3) step = 2;
  else if (normalized < 7) step = 5;
  else step = 10;
  return step * magnitude;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function fmtCurrency(n) {
  return '£' + Math.round(n).toLocaleString('en-GB');
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtHour(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// series: [{date, without, with}], both non-negative, with <= without.
function renderComparisonChart(container, series, opts) {
  opts = opts || {};
  container.innerHTML = '';
  if (!series || series.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No data yet for this period.';
    container.appendChild(empty);
    return;
  }

  const fmtX = opts.granularity === 'hour' ? fmtHour : fmtDate;

  // Size the viewBox to the container's actual current width rather than a
  // fixed 720 scaled down by CSS -- on a phone-width card, scaling a fixed
  // 720-wide viewBox down via width:100% shrinks the text/markers along
  // with everything else to the point of being unreadable. Setting the SVG's
  // width/height attributes to these exact pixel values (not '100%') means
  // the viewBox always renders 1:1, so text stays at its natural, legible
  // size at any width; a shorter aspect ratio on narrow screens avoids an
  // overly tall chart relative to how little width it has to work with.
  const W = Math.min(720, container.clientWidth || 720);
  const H = W < 500 ? 220 : 260;
  const margin = { top: 16, right: 16, bottom: 28, left: 44 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  const maxRaw = Math.max(...series.map((d) => Math.max(d.without, d.with)), 1);
  const step = niceStep(maxRaw);
  const yMax = Math.ceil(maxRaw / step) * step * 1.05;

  const x = (i) => margin.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v) => margin.top + plotH - (v / yMax) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || 'Comparison chart' });
  svg.style.display = 'block';
  svg.style.maxWidth = '100%';

  // Gridlines + y labels (hairline, recessive)
  const gridGroup = svgEl('g');
  for (let v = 0; v <= yMax; v += step) {
    const gy = y(v);
    gridGroup.appendChild(svgEl('line', { x1: margin.left, x2: W - margin.right, y1: gy, y2: gy, stroke: 'rgba(255,255,255,0.10)', 'stroke-width': 1 }));
    const label = svgEl('text', { x: margin.left - 8, y: gy + 4, 'text-anchor': 'end', 'font-size': '10.5', fill: '#a9adaf', 'font-family': 'Arial, Helvetica, sans-serif' });
    label.textContent = opts.unit === 'kwh' ? Math.round(v).toLocaleString('en-GB') : fmtCurrency(v);
    gridGroup.appendChild(label);
  }
  svg.appendChild(gridGroup);

  function areaPath(key) {
    const top = series.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d[key])}`).join(' ');
    const base = `L ${x(series.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
    return `${top} ${base}`;
  }
  function linePath(key) {
    return series.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d[key])}`).join(' ');
  }

  // "without" area first (teal wash), "with" area on top (yellow wash) —
  // the overlap between them visually is the savings band.
  svg.appendChild(svgEl('path', { d: areaPath('without'), fill: CHART_COLORS.withoutPhase1, opacity: 0.10 }));
  svg.appendChild(svgEl('path', { d: areaPath('with'), fill: CHART_COLORS.withPhase1, opacity: 0.10 }));

  svg.appendChild(svgEl('path', { d: linePath('without'), fill: 'none', stroke: CHART_COLORS.withoutPhase1, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.appendChild(svgEl('path', { d: linePath('with'), fill: 'none', stroke: CHART_COLORS.withPhase1, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // End-dot markers + direct end labels (lines carry the value at the end)
  const lastIdx = series.length - 1;
  [['without', CHART_COLORS.withoutPhase1], ['with', CHART_COLORS.withPhase1]].forEach(([key, color]) => {
    const cx = x(lastIdx), cy = y(series[lastIdx][key]);
    svg.appendChild(svgEl('circle', { cx, cy, r: 5, fill: color, stroke: '#3D4347', 'stroke-width': 2 }));
  });

  // x-axis: first/last date only (sparse, per spec)
  const xLabels = svgEl('g');
  [0, lastIdx].forEach((i) => {
    if (lastIdx === 0 && i > 0) return;
    const label = svgEl('text', {
      x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : 'end',
      'font-size': '11', fill: '#a9adaf', 'font-family': 'Arial, Helvetica, sans-serif',
    });
    label.textContent = fmtX(series[i].date);
    xLabels.appendChild(label);
  });
  svg.appendChild(xLabels);

  // Hover layer: crosshair + tooltip
  const crosshair = svgEl('line', { y1: margin.top, y2: margin.top + plotH, stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(crosshair);
  const hoverRect = svgEl('rect', { x: margin.left, y: margin.top, width: plotW, height: plotH, fill: 'transparent' });
  svg.appendChild(hoverRect);

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.style.cssText = 'position:absolute;pointer-events:none;background:#23262a;color:#fff;font-size:12px;padding:8px 10px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,0.3);display:none;white-space:nowrap;z-index:10;';
  wrap.appendChild(tooltip);

  function showAt(i) {
    const d = series[i];
    crosshair.setAttribute('x1', x(i));
    crosshair.setAttribute('x2', x(i));
    crosshair.setAttribute('visibility', 'visible');
    const unitFmt = opts.unit === 'kwh' ? (n) => Math.round(n).toLocaleString('en-GB') + ' kWh' : fmtCurrency;
    tooltip.innerHTML =
      `<strong>${fmtX(d.date)}</strong><br>` +
      `<span style="color:${CHART_COLORS.withPhase1}">●</span> ${opts.withLabel || 'With Phase 1'}: ${unitFmt(d.with)}<br>` +
      `<span style="color:${CHART_COLORS.withoutPhase1}">●</span> ${opts.withoutLabel || 'Without Phase 1'}: ${unitFmt(d.without)}`;
    tooltip.style.display = 'block';
    const px = (x(i) / W) * wrap.clientWidth;
    tooltip.style.left = Math.min(px + 12, wrap.clientWidth - 170) + 'px';
    tooltip.style.top = '4px';
  }
  function hide() {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.style.display = 'none';
  }
  hoverRect.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(lastIdx, Math.round(((relX - margin.left) / plotW) * lastIdx)));
    showAt(i);
  });
  hoverRect.addEventListener('mouseleave', hide);
  hoverRect.addEventListener('touchstart', (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.touches[0].clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(lastIdx, Math.round(((relX - margin.left) / plotW) * lastIdx)));
    showAt(i);
  }, { passive: true });

  container.appendChild(wrap);

  // Legend (always present for 2 series)
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.style.marginTop = '4px';
  legend.innerHTML = `
    <div class="item"><span class="swatch" style="background:${CHART_COLORS.withPhase1}"></span>${opts.withLabel || 'With Phase 1 (actual)'}</div>
    <div class="item"><span class="swatch" style="background:${CHART_COLORS.withoutPhase1}"></span>${opts.withoutLabel || 'Without Phase 1 (grid only)'}</div>
  `;
  container.appendChild(legend);
}

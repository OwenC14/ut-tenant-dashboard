function fmtGBP(n) { return '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 0 }); }
function fmtKwh(n) { return Math.round(n).toLocaleString('en-GB') + ' kWh'; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB') : '—'; }

const STATUS_LABELS = {
  not_connected: 'Not connected',
  no_tenant: 'No tenant account',
  awaiting_data: 'Awaiting first data',
  disconnected: 'Disconnected',
  ok: 'OK',
};

let allProperties = [];
let sortState = { key: 'address', dir: 1 };
let currentRange = 'month';
let currentDrilldownPropertyId = null;
let currentDrilldownData = null; // last-fetched drilldown, redrawn (not refetched) on sort/filter

function fmtHourLabel(iso) {
  return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}

function showRequiredActions(p) {
  document.getElementById('requiredActionsAddress').textContent = ` — ${p.address}`;
  document.getElementById('requiredActionsStatusLabel').textContent = `Status: ${STATUS_LABELS[p.status] || p.status}`;
  const list = document.getElementById('requiredActionsList');
  list.innerHTML = p.requiredActions.map((a) => `<li>${a}</li>`).join('');
  document.getElementById('requiredActionsModal').style.display = 'flex';
}
document.getElementById('requiredActionsClose').addEventListener('click', () => {
  document.getElementById('requiredActionsModal').style.display = 'none';
});

function sortProperties(list) {
  const { key, dir } = sortState;
  return [...list].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === 'status') { av = STATUS_LABELS[av] || av; bv = STATUS_LABELS[bv] || bv; }
    if (key === 'connectionDate') {
      av = av ? new Date(av).getTime() : -Infinity;
      bv = bv ? new Date(bv).getTime() : -Infinity;
      return (av - bv) * dir;
    }
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
}

function renderPropertiesTable() {
  const filter = document.getElementById('statusFilter').value;
  const filtered = filter ? allProperties.filter((p) => p.status === filter) : allProperties;
  const sorted = sortProperties(filtered);

  document.getElementById('propertiesShownCount').textContent =
    `Showing ${sorted.length} of ${allProperties.length} properties`;

  document.querySelectorAll('.admin-table th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sortState.key);
    th.querySelector('.arrow').textContent = th.dataset.sort === sortState.key ? (sortState.dir === 1 ? '▲' : '▼') : '↕';
  });

  const tbody = document.getElementById('propertiesBody');
  tbody.innerHTML = '';
  sorted.forEach((p) => {
    const tr = document.createElement('tr');
    const label = STATUS_LABELS[p.status] || p.status;
    const statusHtml = p.status === 'ok'
      ? `<span class="status-pill status-ok">${label}</span>`
      : `<button type="button" class="status-pill status-${p.status} clickable">${label}</button>`;
    tr.innerHTML = `<td>${p.address}</td><td>${p.postcode || '—'}</td><td>${p.tenantName}</td>` +
      `<td>${fmtDate(p.connectionDate)}</td><td>${statusHtml}</td><td class="drilldown-cell" data-property-id="${p.id}"></td>`;
    if (p.status !== 'ok') {
      tr.querySelector('.status-pill').addEventListener('click', () => showRequiredActions(p));
    }
    const cell = tr.querySelector('.drilldown-cell');
    if (p.id === currentDrilldownPropertyId && currentDrilldownData) {
      renderDrilldownCell(cell, currentDrilldownData);
    } else if (p.drilldownAvailable) {
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'View usage data';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        viewDrilldown(p, cell);
      });
      cell.appendChild(link);
    } else {
      cell.innerHTML = '<span class="hint">Not shared</span>';
    }
    tbody.appendChild(tr);
  });
}

document.getElementById('statusFilter').addEventListener('change', renderPropertiesTable);
document.querySelectorAll('.admin-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    if (sortState.key === th.dataset.sort) {
      sortState.dir *= -1;
    } else {
      sortState = { key: th.dataset.sort, dir: 1 };
    }
    renderPropertiesTable();
  });
});

function renderDrilldownCell(cellEl, data) {
  const unitLabel = data.granularity === 'hour' ? `${data.days}h` : `${data.days}d`;
  cellEl.textContent = `${fmtGBP(data.saving)} saved (${unitLabel}) — see detail below`;
}

async function viewDrilldown(property, cellEl) {
  currentDrilldownPropertyId = property.id;
  currentDrilldownData = null;
  cellEl.textContent = 'Loading…';
  const res = await fetch(`/portfolio/properties/${property.id}?range=${currentRange}`, { credentials: 'include' });
  const data = await res.json();
  if (res.status === 403) {
    cellEl.innerHTML = `<span class="hint">${data.message}</span>`;
    return;
  }
  if (!data.hasData) {
    cellEl.innerHTML = '<span class="hint">No data yet</span>';
    document.getElementById('propertyDetailCard').style.display = 'none';
    return;
  }
  currentDrilldownData = data;
  renderDrilldownCell(cellEl, data);

  document.getElementById('propertyDetailCard').style.display = 'block';
  document.getElementById('propertyDetailAddress').textContent = ` — ${property.address}`;
  document.getElementById('propertyDetailSummary').textContent = data.granularity === 'hour'
    ? `${fmtGBP(data.saving)} saved over the last ${data.days} hours — solar ${fmtKwh(data.solar.kwh)}, battery ${fmtKwh(data.battery.kwh)}, grid ${fmtKwh(data.grid.kwh)}`
    : `${fmtGBP(data.saving)} saved over ${data.days} days — solar ${fmtKwh(data.solar.kwh)}, battery ${fmtKwh(data.battery.kwh)}, grid ${fmtKwh(data.grid.kwh)}`;
  renderComparisonChart(document.getElementById('propertyDetailChart'), data.series, {
    ariaLabel: `${property.address}: bill with and without Phase 1, ${data.granularity === 'hour' ? 'hour by hour' : 'day by day'}`,
    granularity: data.granularity,
  });
  document.getElementById('propertyDetailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function load() {
  const res = await fetch(`/portfolio/summary?range=${currentRange}`, { credentials: 'include' });
  if (res.status === 401) {
    window.location.href = '/portfolio-login.html';
    return;
  }
  const data = await res.json();

  document.getElementById('orgName').textContent = data.organization.name;
  document.getElementById('propertyCount').textContent = data.propertyCount;
  document.getElementById('currentBill').textContent = fmtGBP(data.totals.currentBill);
  document.getElementById('newBill').textContent = fmtGBP(data.totals.newBill);
  document.getElementById('totalSaving').textContent = fmtGBP(data.totals.saving);
  document.getElementById('avgSaving').textContent = fmtGBP(data.totals.avgSavingPerProperty);
  document.getElementById('periodNote').textContent = data.period.end
    ? (data.granularity === 'hour'
        ? `${fmtHourLabel(data.period.start)} to ${fmtHourLabel(data.period.end)} (${data.period.days} hour${data.period.days === 1 ? '' : 's'})`
        : `Last ${data.period.days} days, ending ${fmtDate(data.period.end)}`)
    : 'No data yet for this portfolio';

  const bar = document.getElementById('bar');
  bar.innerHTML = '';
  const consumption = data.totals.solarKwh + data.totals.batteryKwh + data.totals.gridKwh;
  [['seg-solar', data.totals.solarKwh], ['seg-battery', data.totals.batteryKwh], ['seg-grid', data.totals.gridKwh]].forEach(([cls, v]) => {
    const d = document.createElement('div');
    d.className = cls;
    d.style.width = (consumption > 0 ? (v / consumption * 100) : 0) + '%';
    bar.appendChild(d);
  });

  document.getElementById('portfolioChartHint').textContent =
    `Every property in this portfolio, summed ${data.granularity === 'hour' ? 'hour by hour' : 'day by day'} — what they'd have paid at grid price only, versus what solar and battery actually brought it down to.`;

  renderComparisonChart(document.getElementById('portfolioChart'), data.series, {
    ariaLabel: `${data.organization.name}: portfolio bill with and without Phase 1, ${data.granularity === 'hour' ? 'hour by hour' : 'day by day'}`,
    granularity: data.granularity,
  });

  allProperties = data.properties;
  renderPropertiesTable();

  // Keep an open property drill-down in sync with the newly selected range —
  // look the cell up fresh since renderPropertiesTable() just rebuilt the DOM.
  if (currentDrilldownPropertyId !== null) {
    const property = allProperties.find((p) => p.id === currentDrilldownPropertyId);
    const cell = document.querySelector(`.drilldown-cell[data-property-id="${currentDrilldownPropertyId}"]`);
    if (property && cell) {
      viewDrilldown(property, cell);
    } else {
      currentDrilldownPropertyId = null;
      currentDrilldownData = null;
    }
  }
}

function initRangeSelector() {
  const buttons = document.querySelectorAll('#rangeSelector button');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.range === currentRange) return;
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      load();
    });
  });
}

initRangeSelector();
load();

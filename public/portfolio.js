function fmtGBP(n) { return '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 0 }); }
function fmtKwh(n) { return Math.round(n).toLocaleString('en-GB') + ' kWh'; }

async function viewDrilldown(id, cellEl) {
  cellEl.textContent = 'Loading…';
  const res = await fetch(`/portfolio/properties/${id}`, { credentials: 'include' });
  const data = await res.json();
  if (res.status === 403) {
    cellEl.innerHTML = `<span class="hint">${data.message}</span>`;
    return;
  }
  if (!data.hasData) {
    cellEl.innerHTML = '<span class="hint">No data yet</span>';
    return;
  }
  cellEl.textContent =
    `${fmtGBP(data.saving)} saved (${data.days}d) — solar ${fmtKwh(data.solar.kwh)}, ` +
    `battery ${fmtKwh(data.battery.kwh)}, grid ${fmtKwh(data.grid.kwh)}`;
}

async function load() {
  const res = await fetch('/portfolio/summary', { credentials: 'include' });
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
    ? `Last ${data.period.days} days, ending ${data.period.end}`
    : 'No rollup data yet for this portfolio';

  const bar = document.getElementById('bar');
  bar.innerHTML = '';
  const consumption = data.totals.solarKwh + data.totals.batteryKwh + data.totals.gridKwh;
  [['seg-solar', data.totals.solarKwh], ['seg-battery', data.totals.batteryKwh], ['seg-grid', data.totals.gridKwh]].forEach(([cls, v]) => {
    const d = document.createElement('div');
    d.className = cls;
    d.style.width = (consumption > 0 ? (v / consumption * 100) : 0) + '%';
    bar.appendChild(d);
  });

  const tbody = document.getElementById('propertiesBody');
  tbody.innerHTML = '';
  data.properties.forEach((p) => {
    const tr = document.createElement('tr');
    const status = p.flagged
      ? '<span style="color:var(--grid-red);font-weight:bold;">Needs attention</span>'
      : (p.lastRollupDate ? 'OK' : 'Awaiting first data');
    tr.innerHTML = `<td>${p.address}</td><td>${p.tenantName}</td><td>${status}</td><td class="drilldown-cell"></td>`;
    const cell = tr.querySelector('.drilldown-cell');
    if (p.drilldownAvailable) {
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'View usage data';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        viewDrilldown(p.id, cell);
      });
      cell.appendChild(link);
    } else {
      cell.innerHTML = '<span class="hint">Not shared</span>';
    }
    tbody.appendChild(tr);
  });
}

load();

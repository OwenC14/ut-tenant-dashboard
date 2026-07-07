function fmtGBP(n) { return '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 0 }); }

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
    const drilldown = p.drilldownAvailable
      ? '<a href="#">View usage data</a>'
      : '<span class="hint">Not shared</span>';
    tr.innerHTML = `<td>${p.address}</td><td>${p.tenantName}</td><td>${status}</td><td>${drilldown}</td>`;
    tbody.appendChild(tr);
  });
}

load();

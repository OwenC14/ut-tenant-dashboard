function fmtGBP(n) { return '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 0 }); }
function fmtKwh(n) { return Math.round(n).toLocaleString('en-GB') + ' kWh'; }

async function loadRange(range) {
  const res = await fetch(`/api/dashboard?range=${range}`, { credentials: 'include' });
  if (res.status === 401) {
    window.location.href = '/index.html';
    return;
  }
  const data = await res.json();

  document.getElementById('noData').style.display = data.hasData ? 'none' : 'block';
  document.getElementById('resultsWrap').style.display = data.hasData ? 'block' : 'none';
  if (!data.hasData) return;

  document.getElementById('currentBill').textContent = fmtGBP(data.currentBill);
  document.getElementById('newBill').textContent = fmtGBP(data.newBill);
  document.getElementById('totalSaving').textContent = fmtGBP(data.saving);
  document.getElementById('savingPct').textContent = data.savingPct.toFixed(0) + '%';

  document.getElementById('solarSaving').textContent = fmtGBP(data.solar.amount);
  document.getElementById('solarKwh').textContent = fmtKwh(data.solar.kwh);
  document.getElementById('batteryImportCost').textContent = fmtGBP(data.battery.amount) + ' spent';
  document.getElementById('batteryKwh').textContent = fmtKwh(data.battery.kwh);
  document.getElementById('gridCost').textContent = fmtGBP(data.grid.amount) + ' spent';
  document.getElementById('gridKwh').textContent = fmtKwh(data.grid.kwh);

  const bar = document.getElementById('bar');
  bar.innerHTML = '';
  const consumption = data.solar.kwh + data.battery.kwh + data.grid.kwh;
  [['seg-solar', data.solar.kwh], ['seg-battery', data.battery.kwh], ['seg-grid', data.grid.kwh]].forEach(([cls, v]) => {
    const d = document.createElement('div');
    d.className = cls;
    d.style.width = (consumption > 0 ? (v / consumption * 100) : 0) + '%';
    bar.appendChild(d);
  });

  document.getElementById('periodNote').textContent =
    `${data.periodStart} to ${data.periodEnd} (${data.days} day${data.days === 1 ? '' : 's'} of data)`;
}

const buttons = document.querySelectorAll('#rangeSelector button');
buttons.forEach((btn) => {
  btn.addEventListener('click', () => {
    buttons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadRange(btn.dataset.range);
  });
});

// Default view per spec §7: last 4 weeks, not "that day" — a single day's
// weather can be misleading on a tenant's first login.
loadRange('4weeks');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

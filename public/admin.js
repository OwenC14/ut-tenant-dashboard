let adminKey = localStorage.getItem('adminKey') || '';

function authHeaders() {
  return { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
}

function ensureKey() {
  if (!adminKey) {
    adminKey = window.prompt('Admin API key:') || '';
    localStorage.setItem('adminKey', adminKey);
  }
}

async function loadProperties() {
  ensureKey();
  const res = await fetch('/admin/properties', { headers: authHeaders() });
  if (res.status === 401) {
    localStorage.removeItem('adminKey');
    adminKey = '';
    window.alert('Invalid admin key');
    return;
  }
  const data = await res.json();
  const tbody = document.getElementById('propertiesBody');
  tbody.innerHTML = '';
  data.properties.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td>${p.address}</td>
      <td>${p.tenant_name}</td>
      <td>${p.fox_device_sn}</td>
      <td>${p.tenant_email || '—'}</td>
      <td>${p.has_fox_token ? '✓' : '—'}</td>
      <td>${p.last_reading_at ? new Date(p.last_reading_at).toLocaleString('en-GB') : 'never'}</td>
      <td>${p.last_rollup_date || 'never'}</td>
      <td><a href="/oauth/fox/authorize?propertyId=${p.id}" target="_blank">Fox consent link</a></td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  ensureKey();
  const body = {
    address: document.getElementById('address').value,
    tenantName: document.getElementById('tenantName').value,
    foxDeviceSn: document.getElementById('foxDeviceSn').value,
    tenantEmail: document.getElementById('tenantEmail').value || undefined,
    arraySizeKwp: document.getElementById('arraySizeKwp').value ? Number(document.getElementById('arraySizeKwp').value) : undefined,
    batteryCapacityKwh: document.getElementById('batteryCapacityKwh').value ? Number(document.getElementById('batteryCapacityKwh').value) : undefined,
  };
  const res = await fetch('/admin/properties', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  const data = await res.json();
  const msg = document.getElementById('addMessage');
  msg.style.display = 'block';
  if (res.ok) {
    msg.innerHTML = `Created property #${data.id}. <a href="${data.foxAuthorizeUrl}" target="_blank">Fox consent link</a>`;
    document.getElementById('addForm').reset();
    loadProperties();
  } else {
    msg.textContent = `Error: ${data.error}`;
  }
});

loadProperties();

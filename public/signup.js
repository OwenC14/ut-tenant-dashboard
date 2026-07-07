document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('code').value;
  const email = document.getElementById('email').value;
  const res = await fetch('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, email }),
  });
  const data = await res.json();
  const msg = document.getElementById('signupMessage');
  msg.style.display = 'block';
  msg.textContent = data.message || data.error;
});

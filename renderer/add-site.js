// The "Add a site" window. Main checks the text and either saves it or says what's wrong.
const form = document.getElementById('form');
const input = document.getElementById('site');
const error = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const problem = await window.scrollwise.addSite(input.value);
  if (problem) {
    error.textContent = problem;
    input.select();
  } else {
    window.close();
  }
});

input.addEventListener('input', () => (error.textContent = ''));
document.getElementById('cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close();
});

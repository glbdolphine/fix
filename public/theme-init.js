// Applies the saved light/dark theme before the page paints (no flash).
// This is a separate file, not an inline <script>, so the Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var t = localStorage.getItem('pace_it_theme');
    if (!t && window.matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark';
    if (t === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();

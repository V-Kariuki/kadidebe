import { useTheme } from '../theme/ThemeContext.jsx';

export default function ThemeToggleFloating() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      className="theme-toggle-floating"
      onClick={toggleTheme}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle color theme"
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}

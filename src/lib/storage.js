const SET_KEY = "linerNotes.settings.v1";

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable / full — ignore */
  }
}

export const loadSettings = () => load(SET_KEY, { showRomaji: true, size: 1.55 });
export const saveSettings = (s) => save(SET_KEY, s);

/* racks3d — a data set imported from a file in this browser (Import in the top bar).
 * It is kept in localStorage, never uploaded, and replaces the sample on load.
 * ?data=private still wins, and Import → "Back to the sample" forgets it.
 */
(function () {
  'use strict';
  const KEY = 'racks3d.imported';
  const store = {
    load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    save(entry) { try { localStorage.setItem(KEY, JSON.stringify(entry)); return true; } catch (e) { return false; } },
    clear() { try { localStorage.removeItem(KEY); } catch (e) { /* nothing stored */ } },
  };
  window.Racks3dImport = store;
  if (/[?&]data=private\b/.test(location.search)) return;
  const entry = store.load();
  if (!entry || !entry.data || !Array.isArray(entry.data.racks) || !entry.data.racks.length) return;
  entry.data.meta = Object.assign({}, entry.data.meta, { title: 'Imported · ' + entry.name, imported: true });
  window.DC_DATA = entry.data;
})();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const SAVE_DEBOUNCE_MS = 250;

/**
 * Flat-file JSON persistence for calibration records and completed runs.
 * Small LAN tool, no database - this is just enough to survive a restart.
 */
export class Store {
  constructor() {
    this.data = this._load();
    this._saveTimer = null;
  }

  _load() {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        calibrations: parsed.calibrations || {},
        runs: parsed.runs || {},
        profiles: parsed.profiles || {},
      };
    } catch {
      return { calibrations: {}, runs: {}, profiles: {} };
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2));
    }, SAVE_DEBOUNCE_MS);
  }

  getCalibrations() {
    return this.data.calibrations;
  }

  saveCalibration(moduleId, record) {
    this.data.calibrations[moduleId] = record;
    this._scheduleSave();
    return record;
  }

  listProfiles(moduleId) {
    return this.data.profiles[moduleId] || [];
  }

  saveProfile(moduleId, profile) {
    const list = this.data.profiles[moduleId] || (this.data.profiles[moduleId] = []);
    const i = list.findIndex((p) => p.id === profile.id);
    if (i >= 0) list[i] = profile;
    else list.push(profile);
    this._scheduleSave();
    return profile;
  }

  deleteProfile(moduleId, profileId) {
    const list = this.data.profiles[moduleId];
    if (!list) return;
    this.data.profiles[moduleId] = list.filter((p) => p.id !== profileId);
    this._scheduleSave();
  }

  listRuns() {
    return Object.values(this.data.runs)
      .map(({ series, ...summary }) => summary)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  getRun(id) {
    return this.data.runs[id] || null;
  }

  saveRun(run) {
    this.data.runs[run.id] = run;
    this._scheduleSave();
    return run;
  }
}

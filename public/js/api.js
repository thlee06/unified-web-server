async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  fetchCalibrations: () => fetch('/api/calibrations').then(json),
  saveCalibration: (moduleId, record) =>
    fetch(`/api/calibrations/${encodeURIComponent(moduleId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).then(json),
  fetchProfiles: (moduleId) => fetch(`/api/profiles/${encodeURIComponent(moduleId)}`).then(json),
  saveProfile: (moduleId, profile) =>
    fetch(`/api/profiles/${encodeURIComponent(moduleId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    }).then(json),
  deleteProfile: (moduleId, profileId) =>
    fetch(`/api/profiles/${encodeURIComponent(moduleId)}/${encodeURIComponent(profileId)}`, { method: 'DELETE' }),
  fetchRuns: () => fetch('/api/runs').then(json),
  fetchRun: (id) => fetch(`/api/runs/${encodeURIComponent(id)}`).then(json),
  createRun: (run) =>
    fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(run),
    }).then(json),
  csvUrl: (id) => `/api/runs/${encodeURIComponent(id)}/csv`,
};

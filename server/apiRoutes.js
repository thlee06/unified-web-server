import express from 'express';

const MODULE_ID_RE = /^[A-Za-z0-9_-]+$/;

function toCsv(run) {
  const lines = ['t_ms,module,channel,value'];
  for (const [moduleId, moduleSeries] of Object.entries(run.series || {})) {
    const t = moduleSeries.t || [];
    for (const [channelKey, values] of Object.entries(moduleSeries.values || {})) {
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null || values[i] === undefined) continue;
        lines.push(`${t[i] ?? ''},${moduleId},${channelKey},${values[i]}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * REST API for calibration records and completed runs. The live device/
 * sample stream itself stays on the /dashboard and /ingest WS endpoints -
 * this only persists the guided-workflow state layered on top of it.
 */
export function createApiRouter(store) {
  const router = express.Router();
  router.use(express.json({ limit: '25mb' }));

  router.get('/calibrations', (req, res) => {
    res.json(store.getCalibrations());
  });

  router.put('/calibrations/:moduleId', (req, res) => {
    const { moduleId } = req.params;
    if (!MODULE_ID_RE.test(moduleId)) {
      return res.status(400).json({ error: 'invalid module id' });
    }
    const record = req.body;
    if (!record || typeof record !== 'object') {
      return res.status(400).json({ error: 'missing calibration record' });
    }
    res.json(store.saveCalibration(moduleId, record));
  });

  router.get('/profiles/:moduleId', (req, res) => {
    const { moduleId } = req.params;
    if (!MODULE_ID_RE.test(moduleId)) {
      return res.status(400).json({ error: 'invalid module id' });
    }
    res.json(store.listProfiles(moduleId));
  });

  router.post('/profiles/:moduleId', (req, res) => {
    const { moduleId } = req.params;
    if (!MODULE_ID_RE.test(moduleId)) {
      return res.status(400).json({ error: 'invalid module id' });
    }
    const profile = req.body;
    if (!profile || typeof profile !== 'object' || !profile.name) {
      return res.status(400).json({ error: 'missing profile name' });
    }
    const saved = {
      ...profile,
      id: profile.id || `prof_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      savedAt: Date.now(),
    };
    res.status(201).json(store.saveProfile(moduleId, saved));
  });

  router.delete('/profiles/:moduleId/:profileId', (req, res) => {
    const { moduleId, profileId } = req.params;
    if (!MODULE_ID_RE.test(moduleId)) {
      return res.status(400).json({ error: 'invalid module id' });
    }
    store.deleteProfile(moduleId, profileId);
    res.status(204).end();
  });

  router.get('/runs', (req, res) => {
    res.json(store.listRuns());
  });

  router.get('/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(run);
  });

  router.get('/runs/:id/csv', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${run.id}.csv"`);
    res.send(toCsv(run));
  });

  router.post('/runs', (req, res) => {
    const run = req.body;
    if (!run || typeof run !== 'object' || !run.id || !run.name) {
      return res.status(400).json({ error: 'invalid run payload' });
    }
    res.status(201).json(store.saveRun(run));
  });

  return router;
}

/* Parser for the local exporter's garmin-data.json.

   This is the offline / fallback path: the user runs garmin/server/export_local.py
   on their own machine and drops the resulting garmin-data.json here. The file
   already has exactly the shape the dashboard wants (same schema the live
   backend returns), so this mostly validates and lightly normalises it. */

function parseGarminExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Fichier illisible : ce n'est pas un JSON valide.");
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.activities)) {
    throw new Error("Ce n'est pas un export Garmin (garmin-data.json) valide.");
  }

  const activities = data.activities
    .filter(a => a && a.date && a.distance > 0)
    .map(a => ({ kudos: 0, ...a }))
    .sort((x, y) => new Date(y.date) - new Date(x.date));

  if (!activities.length && !(Array.isArray(data.wellness) && data.wellness.length)) {
    throw new Error("Aucune activité ni donnée wellness exploitable dans le fichier.");
  }

  return {
    athlete: data.athlete || { name: 'Athlète' },
    activities,
    wellness: Array.isArray(data.wellness) ? data.wellness : [],
    snapshot: data.snapshot || {}
  };
}

/* Merge imported data into a profile's cache. Activities dedupe by id and
   wellness by date, so re-importing a fresher export only adds what's new
   (the "sync without a server" path). */
function mergeImportedData(profileId, parsed) {
  const byId = new Map();
  (Profile.getJSON(PKEY.activities, profileId) || []).forEach(a => byId.set(String(a.id), a));
  parsed.activities.forEach(a => byId.set(String(a.id), a));
  const mergedActs = [...byId.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
  Profile.setJSON(PKEY.activities, mergedActs, profileId);

  const byDate = new Map();
  (Profile.getJSON(PKEY.wellness, profileId) || []).forEach(w => byDate.set(w.date, w));
  parsed.wellness.forEach(w => byDate.set(w.date, w));
  const mergedWell = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  Profile.setJSON(PKEY.wellness, mergedWell, profileId);

  if (parsed.snapshot && Object.keys(parsed.snapshot).length) {
    Profile.setJSON(PKEY.snapshot, parsed.snapshot, profileId);
  }
  if (parsed.athlete) Profile.setJSON(PKEY.athlete, parsed.athlete, profileId);
  Profile.set(PKEY.lastSync, String(Math.floor(Date.now() / 1000)), profileId);
  return { activities: mergedActs, wellness: mergedWell };
}

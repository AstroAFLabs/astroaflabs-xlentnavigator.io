(function () {
  'use strict';

  const DB_NAME = 'waypoint-trip-recorder';
  const DB_VERSION = 1;
  const ACTIVE_KEY = 'active';
  const SETTINGS_KEY = 'waypointTripRecorderSettingsV1';
  const GPS_ACCURACY_LIMIT_M = 80;
  const MIN_SEGMENT_M = 3;
  const STATIONARY_SAMPLE_MS = 15000;
  const MAX_INFERRED_SPEED_KMH = 220;
  const MAX_POINTS_PER_TRIP = 50000;

  let dbPromise = null;
  let activeTrip = null;
  let watchId = null;
  let wakeLock = null;
  let currentTrackLayer = null;
  let currentMarkerLayer = null;
  let historyLayer = null;
  let metricsTimer = null;
  let lastPersistAt = 0;
  let lastPosition = null;
  let tripCache = [];
  let settings = loadSettings();

  const ui = {};

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          autoStartWithNav: parsed.autoStartWithNav !== false
        };
      }
    } catch (error) {
      console.warn('Trip recorder settings could not be loaded.', error);
    }
    return { autoStartWithNav: true };
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('Trip recorder settings could not be saved.', error);
    }
  }

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is unavailable in this browser.'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state');
        }
        if (!db.objectStoreNames.contains('trips')) {
          const store = db.createObjectStore('trips', { keyPath: 'id' });
          store.createIndex('startedAt', 'startedAt', { unique: false });
        }
      };

      request.onsuccess = function () {
        resolve(request.result);
      };

      request.onerror = function () {
        reject(request.error || new Error('Could not open trip database.'));
      };
    });

    return dbPromise;
  }

  async function idbGet(storeName, key) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function idbPut(storeName, value, key) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = key === undefined ? store.put(value) : store.put(value, key);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).delete(key);
      request.onsuccess = function () { resolve(); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function idbGetAllTrips() {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('trips', 'readonly');
      const request = tx.objectStore('trips').getAll();
      request.onsuccess = function () {
        const rows = Array.isArray(request.result) ? request.result : [];
        rows.sort(function (a, b) {
          return String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
        });
        resolve(rows);
      };
      request.onerror = function () { reject(request.error); };
    });
  }

  function safeMap() {
    try {
      if (typeof map !== 'undefined' && map && typeof map.addLayer === 'function') {
        return map;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function safeLeaflet() {
    return typeof L !== 'undefined' ? L : null;
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = function (value) { return value * Math.PI / 180; };
    const p1 = toRad(a.lat);
    const p2 = toRad(b.lat);
    const dp = toRad(b.lat - a.lat);
    const dl = toRad(b.lng - a.lng);
    const q =
      Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) *
      Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  }

  function distanceMeters(a, b) {
    const leaflet = safeLeaflet();
    if (leaflet && leaflet.latLng) {
      return leaflet.latLng(a.lat, a.lng).distanceTo(leaflet.latLng(b.lat, b.lng));
    }
    return haversineMeters(a, b);
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'trip-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function getPlanSnapshot() {
    const snapshot = {
      distanceKm: null,
      durationMin: null,
      stopsCount: null,
      stops: []
    };

    try {
      if (typeof lastRouteSummary !== 'undefined' && lastRouteSummary) {
        if (Number.isFinite(lastRouteSummary.distanceKm)) {
          snapshot.distanceKm = Number(lastRouteSummary.distanceKm);
        }
        if (Number.isFinite(lastRouteSummary.durationMin)) {
          snapshot.durationMin = Number(lastRouteSummary.durationMin);
        }
        if (Number.isFinite(lastRouteSummary.stopsCount)) {
          snapshot.stopsCount = Number(lastRouteSummary.stopsCount);
        }
      }
    } catch (error) {
      console.debug('No route summary available for trip snapshot.', error);
    }

    try {
      if (typeof routePoints !== 'undefined' && Array.isArray(routePoints)) {
        snapshot.stops = routePoints
          .filter(function (point) {
            return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
          })
          .map(function (point) {
            return { lat: Number(point[0]), lng: Number(point[1]) };
          });
        if (snapshot.stopsCount === null) {
          snapshot.stopsCount = snapshot.stops.length;
        }
      }
    } catch (error) {
      console.debug('No route points available for trip snapshot.', error);
    }

    return snapshot;
  }

  function currentNotes() {
    try {
      if (typeof notesTextarea !== 'undefined' && notesTextarea) {
        return String(notesTextarea.value || '').trim();
      }
    } catch (error) {
      return '';
    }
    return '';
  }

  function newTrip() {
    const plan = getPlanSnapshot();
    return {
      id: createId(),
      version: 1,
      status: 'recording',
      startedAt: isoNow(),
      endedAt: null,
      pausedMs: 0,
      pauseStartedAt: null,
      distanceM: 0,
      points: [],
      stops: [],
      plannedDistanceKm: plan.distanceKm,
      plannedDurationMin: plan.durationMin,
      plannedStopsCount: plan.stopsCount,
      plannedStops: plan.stops,
      notes: currentNotes(),
      device: navigator.userAgent || ''
    };
  }

  function elapsedMs(trip, nowMs) {
    if (!trip || !trip.startedAt) return 0;
    const started = Date.parse(trip.startedAt);
    if (!Number.isFinite(started)) return 0;

    const end = trip.endedAt ? Date.parse(trip.endedAt) : (nowMs || Date.now());
    let paused = Number(trip.pausedMs || 0);

    if (trip.pauseStartedAt && (trip.status === 'paused' || trip.status === 'interrupted')) {
      const pauseStart = Date.parse(trip.pauseStartedAt);
      if (Number.isFinite(pauseStart)) {
        paused += Math.max(0, end - pauseStart);
      }
    }

    return Math.max(0, end - started - paused);
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
    }
    return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  }

  function formatLocalDateTime(iso) {
    if (!iso) return 'Unknown time';
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return iso;
    return value.toLocaleString();
  }

  async function persistActive(force) {
    if (!activeTrip) return;
    const now = Date.now();
    if (!force && now - lastPersistAt < 4000) return;
    lastPersistAt = now;
    try {
      await idbPut('state', activeTrip, ACTIVE_KEY);
    } catch (error) {
      console.error('Could not persist active trip.', error);
      setRecorderStatus('Could not save trip state locally.', 'error');
    }
  }

  async function clearPersistedActive() {
    try {
      await idbDelete('state', ACTIVE_KEY);
    } catch (error) {
      console.warn('Could not clear active trip state.', error);
    }
  }

  function setRecorderStatus(message, kind) {
    if (!ui.status) return;
    ui.status.textContent = message;
    ui.status.dataset.kind = kind || 'info';
  }

  function setGpsStatus(message) {
    if (ui.gps) ui.gps.textContent = message;
  }

  function ensureStyle() {
    if (document.getElementById('waypoint-trip-recorder-style')) return;

    const style = document.createElement('style');
    style.id = 'waypoint-trip-recorder-style';
    style.textContent =
      '#trip-recorder-section .tr-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}' +
      '#trip-recorder-section .tr-metric{border:1px solid rgba(148,163,184,.35);border-radius:9px;padding:6px;background:rgba(2,6,23,.45)}' +
      '#trip-recorder-section .tr-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}' +
      '#trip-recorder-section .tr-value{font-size:16px;font-weight:700;color:var(--text);margin-top:2px}' +
      '#trip-recorder-section .tr-status{padding:6px 8px;border-radius:8px;font-size:11px;border:1px solid rgba(148,163,184,.35);color:var(--muted)}' +
      '#trip-recorder-section .tr-status[data-kind="recording"]{border-color:#22c55e;color:#bbf7d0;background:rgba(34,197,94,.1)}' +
      '#trip-recorder-section .tr-status[data-kind="warning"]{border-color:#f59e0b;color:#fde68a;background:rgba(245,158,11,.1)}' +
      '#trip-recorder-section .tr-status[data-kind="error"]{border-color:#ef4444;color:#fecaca;background:rgba(239,68,68,.1)}' +
      '#trip-recorder-section .tr-history-summary{font-size:11px;color:var(--muted);line-height:1.45}' +
      '#trip-recorder-section select{min-width:0}' +
      '#trip-recorder-section .tr-recording-dot{display:inline-block;width:8px;height:8px;border-radius:999px;background:#ef4444;margin-right:5px}' +
      '#trip-recorder-section .tr-background-note{font-size:10px;color:#fbbf24;line-height:1.35}' +
      '#trip-recorder-chip{position:absolute;top:78px;left:50%;transform:translateX(-50%);z-index:5;padding:5px 10px;border-radius:999px;background:rgba(15,23,42,.9);border:1px solid rgba(239,68,68,.75);font-size:11px;color:#fecaca;display:none;max-width:calc(100% - 24px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '@media(max-width:420px){#trip-recorder-section .tr-grid{grid-template-columns:1fr 1fr}}';
    document.head.appendChild(style);
  }

  function ensureUi() {
    const panel = document.getElementById('control-panel');
    if (!panel || document.getElementById('trip-recorder-section')) return;

    ensureStyle();

    const section = document.createElement('div');
    section.className = 'panel-section';
    section.id = 'trip-recorder-section';
    section.innerHTML =
      '<div class="section-header" data-section="trip-recorder">' +
        '<div class="section-title"><span class="emoji">🛰️</span><span>Actual trip recorder</span></div>' +
        '<div class="section-toggle-icon">▾</div>' +
      '</div>' +
      '<div class="section-body" data-section-body="trip-recorder">' +
        '<div id="tr-status" class="tr-status">Recorder ready.</div>' +
        '<div class="tr-grid">' +
          '<div class="tr-metric"><div class="tr-label">Actual distance</div><div id="tr-distance" class="tr-value">0.00 km</div></div>' +
          '<div class="tr-metric"><div class="tr-label">Elapsed</div><div id="tr-elapsed" class="tr-value">0m 00s</div></div>' +
          '<div class="tr-metric"><div class="tr-label">GPS points</div><div id="tr-points" class="tr-value">0</div></div>' +
          '<div class="tr-metric"><div class="tr-label">Plan variance</div><div id="tr-variance" class="tr-value">—</div></div>' +
        '</div>' +
        '<div id="tr-gps" class="small-text">GPS idle.</div>' +
        '<div class="btn-row">' +
          '<button id="tr-start" class="btn primary" type="button"><span class="btn-icon">●</span> Start trip</button>' +
          '<button id="tr-pause" class="btn" type="button" disabled>Pause</button>' +
          '<button id="tr-stop" class="btn danger" type="button" disabled>Stop & save</button>' +
          '<button id="tr-mark-stop" class="btn" type="button" disabled>📍 Mark stop</button>' +
        '</div>' +
        '<label class="checkbox-row"><input id="tr-auto-nav" type="checkbox" /> Start recording when I press Start nav</label>' +
        '<div class="tr-background-note">For reliable logging on Android, keep WayPoint visible. If Google Maps is brought to the foreground, Android may throttle or suspend browser GPS.</div>' +
        '<div style="height:1px;background:rgba(148,163,184,.25);margin:2px 0"></div>' +
        '<label class="inline-label" for="tr-history">Saved trips on this device</label>' +
        '<select id="tr-history"><option value="">No saved trips yet</option></select>' +
        '<div id="tr-history-summary" class="tr-history-summary">Trips are stored locally in this browser using IndexedDB.</div>' +
        '<div class="btn-row">' +
          '<button id="tr-show" class="btn small" type="button" disabled>Show on map</button>' +
          '<button id="tr-gpx" class="btn small" type="button" disabled>Export GPX</button>' +
          '<button id="tr-geojson" class="btn small" type="button" disabled>Export GeoJSON</button>' +
          '<button id="tr-csv" class="btn small" type="button" disabled>Export CSV</button>' +
          '<button id="tr-delete" class="btn small danger" type="button" disabled>Delete</button>' +
        '</div>' +
      '</div>';

    const notesSection = panel.querySelector('.section-header[data-section="notes"]');
    const notesCard = notesSection ? notesSection.closest('.panel-section') : null;
    if (notesCard) {
      panel.insertBefore(section, notesCard);
    } else {
      panel.appendChild(section);
    }

    const chip = document.createElement('div');
    chip.id = 'trip-recorder-chip';
    chip.textContent = 'Recording trip';
    document.body.appendChild(chip);

    ui.section = section;
    ui.status = document.getElementById('tr-status');
    ui.distance = document.getElementById('tr-distance');
    ui.elapsed = document.getElementById('tr-elapsed');
    ui.points = document.getElementById('tr-points');
    ui.variance = document.getElementById('tr-variance');
    ui.gps = document.getElementById('tr-gps');
    ui.start = document.getElementById('tr-start');
    ui.pause = document.getElementById('tr-pause');
    ui.stop = document.getElementById('tr-stop');
    ui.markStop = document.getElementById('tr-mark-stop');
    ui.autoNav = document.getElementById('tr-auto-nav');
    ui.history = document.getElementById('tr-history');
    ui.historySummary = document.getElementById('tr-history-summary');
    ui.show = document.getElementById('tr-show');
    ui.gpx = document.getElementById('tr-gpx');
    ui.geojson = document.getElementById('tr-geojson');
    ui.csv = document.getElementById('tr-csv');
    ui.delete = document.getElementById('tr-delete');
    ui.chip = chip;

    ui.autoNav.checked = settings.autoStartWithNav;

    section.querySelector('.section-header').addEventListener('click', function () {
      const body = section.querySelector('.section-body');
      const icon = section.querySelector('.section-toggle-icon');
      const collapsed = body.classList.toggle('collapsed');
      icon.textContent = collapsed ? '▸' : '▾';
    });

    ui.start.addEventListener('click', function () {
      startOrResume().catch(handleFatalUiError);
    });

    ui.pause.addEventListener('click', function () {
      pauseTrip().catch(handleFatalUiError);
    });

    ui.stop.addEventListener('click', function () {
      stopAndSave().catch(handleFatalUiError);
    });

    ui.markStop.addEventListener('click', function () {
      markStop().catch(handleFatalUiError);
    });

    ui.autoNav.addEventListener('change', function () {
      settings.autoStartWithNav = ui.autoNav.checked;
      saveSettings();
    });

    ui.history.addEventListener('change', updateSelectedTripSummary);
    ui.show.addEventListener('click', showSelectedTrip);
    ui.gpx.addEventListener('click', function () { exportSelectedTrip('gpx'); });
    ui.geojson.addEventListener('click', function () { exportSelectedTrip('geojson'); });
    ui.csv.addEventListener('click', function () { exportSelectedTrip('csv'); });
    ui.delete.addEventListener('click', function () {
      deleteSelectedTrip().catch(handleFatalUiError);
    });

    const startNav = document.getElementById('btn-start-nav');
    if (startNav) {
      startNav.addEventListener('click', function () {
        if (!settings.autoStartWithNav) return;
        const plan = getPlanSnapshot();
        if (!plan.stopsCount) return;
        if (!activeTrip || activeTrip.status !== 'recording') {
          startOrResume().catch(handleFatalUiError);
        }
      });
    }
  }

  function handleFatalUiError(error) {
    console.error(error);
    setRecorderStatus(error && error.message ? error.message : 'Trip recorder error.', 'error');
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        await navigator.storage.persist();
      }
    } catch (error) {
      console.debug('Persistent storage request was not available.', error);
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () {
          wakeLock = null;
        });
      }
    } catch (error) {
      console.debug('Screen wake lock was not granted.', error);
    }
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;
    try {
      await wakeLock.release();
    } catch (error) {
      console.debug('Wake lock release failed.', error);
    }
    wakeLock = null;
  }

  function clearWatch() {
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
  }

  function startGpsWatch() {
    if (!navigator.geolocation) {
      throw new Error('This device does not provide browser geolocation.');
    }

    clearWatch();

    watchId = navigator.geolocation.watchPosition(
      handlePosition,
      handlePositionError,
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0
      }
    );

    setGpsStatus('Waiting for a high-accuracy GPS fix…');
  }

  async function startOrResume() {
    if (!navigator.geolocation) {
      throw new Error('Geolocation is unavailable. Trip recording cannot start.');
    }

    await requestPersistentStorage();

    if (!activeTrip) {
      activeTrip = newTrip();
    } else {
      if (activeTrip.status === 'paused' || activeTrip.status === 'interrupted') {
        if (activeTrip.pauseStartedAt) {
          const pauseStart = Date.parse(activeTrip.pauseStartedAt);
          if (Number.isFinite(pauseStart)) {
            activeTrip.pausedMs = Number(activeTrip.pausedMs || 0) + Math.max(0, Date.now() - pauseStart);
          }
        }
        activeTrip.pauseStartedAt = null;
        activeTrip.status = 'recording';
      } else if (activeTrip.status === 'recording' && watchId !== null) {
        setRecorderStatus('Trip recording is already running.', 'recording');
        return;
      }
    }

    startGpsWatch();
    await requestWakeLock();
    await persistActive(true);
    renderCurrentTrack();
    startMetricsTimer();
    updateLiveUi();
    setRecorderStatus('Recording actual route. GPS points are being saved locally.', 'recording');
  }

  async function pauseTrip() {
    if (!activeTrip || activeTrip.status !== 'recording') return;

    clearWatch();
    activeTrip.status = 'paused';
    activeTrip.pauseStartedAt = isoNow();
    await persistActive(true);
    await releaseWakeLock();
    updateLiveUi();
    setRecorderStatus('Trip paused. Resume when you start moving again.', 'warning');
    setGpsStatus('GPS recording paused.');
  }

  async function stopAndSave() {
    if (!activeTrip) return;

    clearWatch();

    if (activeTrip.pauseStartedAt) {
      const pauseStart = Date.parse(activeTrip.pauseStartedAt);
      if (Number.isFinite(pauseStart)) {
        activeTrip.pausedMs = Number(activeTrip.pausedMs || 0) + Math.max(0, Date.now() - pauseStart);
      }
    }

    activeTrip.pauseStartedAt = null;
    activeTrip.status = 'completed';
    activeTrip.endedAt = isoNow();
    activeTrip.notes = currentNotes() || activeTrip.notes || '';

    const completed = JSON.parse(JSON.stringify(activeTrip));
    await idbPut('trips', completed);
    await clearPersistedActive();
    await releaseWakeLock();

    activeTrip = null;
    stopMetricsTimer();
    lastPosition = null;
    setRecorderStatus('Trip saved on this device.', 'info');
    setGpsStatus('GPS idle.');
    updateLiveUi();
    await refreshHistory(completed.id);
    showTripOnMap(completed);
  }

  async function markStop() {
    if (!activeTrip || !activeTrip.points.length) {
      setRecorderStatus('Wait for a GPS fix before marking a stop.', 'warning');
      return;
    }

    const point = activeTrip.points[activeTrip.points.length - 1];
    const stop = {
      number: activeTrip.stops.length + 1,
      label: 'Stop ' + (activeTrip.stops.length + 1),
      timestamp: point.timestamp,
      lat: point.lat,
      lng: point.lng,
      cumulativeM: point.cumulativeM
    };

    activeTrip.stops.push(stop);
    await persistActive(true);
    renderCurrentMarkers();
    updateLiveUi();
    setRecorderStatus(stop.label + ' marked at ' + (point.cumulativeM / 1000).toFixed(2) + ' km.', 'recording');
  }

  function handlePosition(position) {
    if (!activeTrip || activeTrip.status !== 'recording') return;

    const coords = position.coords || {};
    const accuracy = Number(coords.accuracy);

    if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      setGpsStatus('GPS returned an invalid coordinate.');
      return;
    }

    if (Number.isFinite(accuracy) && accuracy > GPS_ACCURACY_LIMIT_M) {
      setGpsStatus('Weak GPS fix (' + Math.round(accuracy) + ' m accuracy) — waiting for a cleaner point.');
      return;
    }

    const point = {
      lat: Number(coords.latitude),
      lng: Number(coords.longitude),
      timestamp: new Date(position.timestamp || Date.now()).toISOString(),
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      altitude: Number.isFinite(coords.altitude) ? Number(coords.altitude) : null,
      speedMps: Number.isFinite(coords.speed) ? Number(coords.speed) : null,
      heading: Number.isFinite(coords.heading) ? Number(coords.heading) : null,
      cumulativeM: Number(activeTrip.distanceM || 0)
    };

    const previous = activeTrip.points.length ? activeTrip.points[activeTrip.points.length - 1] : null;

    if (previous) {
      const segmentM = distanceMeters(previous, point);
      const previousTime = Date.parse(previous.timestamp);
      const pointTime = Date.parse(point.timestamp);
      const dtMs = pointTime - previousTime;

      if (!Number.isFinite(segmentM) || segmentM < 0 || !Number.isFinite(dtMs) || dtMs <= 0) {
        return;
      }

      const inferredKmh = (segmentM / (dtMs / 1000)) * 3.6;

      if (inferredKmh > MAX_INFERRED_SPEED_KMH) {
        setGpsStatus('Ignored a GPS jump that implied ' + Math.round(inferredKmh) + ' km/h.');
        return;
      }

      if (segmentM < MIN_SEGMENT_M && dtMs < STATIONARY_SAMPLE_MS) {
        lastPosition = position;
        updateLiveUi(position);
        return;
      }

      activeTrip.distanceM = Number(activeTrip.distanceM || 0) + segmentM;
      point.cumulativeM = activeTrip.distanceM;
    }

    if (activeTrip.points.length >= MAX_POINTS_PER_TRIP) {
      setRecorderStatus('Trip point limit reached. Stop and save this trip before continuing.', 'error');
      pauseTrip().catch(handleFatalUiError);
      return;
    }

    activeTrip.points.push(point);
    lastPosition = position;
    persistActive(false).catch(handleFatalUiError);
    renderCurrentTrack();
    updateLiveUi(position);

    const speedKmh = Number.isFinite(point.speedMps) ? point.speedMps * 3.6 : null;
    const accuracyText = point.accuracy === null ? 'accuracy unknown' : Math.round(point.accuracy) + ' m accuracy';
    setGpsStatus(
      'GPS: ' + accuracyText +
      (speedKmh === null ? '' : ' • ' + Math.round(speedKmh) + ' km/h') +
      ' • last fix ' + new Date(point.timestamp).toLocaleTimeString()
    );
  }

  function handlePositionError(error) {
    const code = error && error.code;
    if (code === 1) {
      setRecorderStatus('Location permission was denied. Allow precise location for this site.', 'error');
      setGpsStatus('GPS permission denied.');
    } else if (code === 2) {
      setGpsStatus('GPS position unavailable. The recorder will keep trying.');
    } else if (code === 3) {
      setGpsStatus('GPS update timed out. The recorder will keep trying.');
    } else {
      setGpsStatus('GPS error. The recorder will keep trying.');
    }
  }

  function startMetricsTimer() {
    stopMetricsTimer();
    metricsTimer = window.setInterval(updateLiveUi, 1000);
  }

  function stopMetricsTimer() {
    if (metricsTimer !== null) {
      window.clearInterval(metricsTimer);
      metricsTimer = null;
    }
  }

  function updateLiveUi(position) {
    if (!ui.distance) return;

    const trip = activeTrip;
    const distanceKm = trip ? Number(trip.distanceM || 0) / 1000 : 0;
    ui.distance.textContent = distanceKm.toFixed(2) + ' km';
    ui.elapsed.textContent = trip ? formatDuration(elapsedMs(trip)) : '0m 00s';
    ui.points.textContent = trip ? String(trip.points.length) : '0';

    if (trip && Number.isFinite(trip.plannedDistanceKm)) {
      const variance = distanceKm - trip.plannedDistanceKm;
      const sign = variance > 0 ? '+' : '';
      ui.variance.textContent = sign + variance.toFixed(2) + ' km';
      ui.variance.title = 'Planned: ' + trip.plannedDistanceKm.toFixed(2) + ' km';
    } else {
      ui.variance.textContent = '—';
      ui.variance.title = 'No planned route distance was available when recording started.';
    }

    const recording = trip && trip.status === 'recording';
    const paused = trip && (trip.status === 'paused' || trip.status === 'interrupted');

    ui.start.disabled = Boolean(recording);
    ui.start.innerHTML = paused
      ? '<span class="btn-icon">▶</span> Resume trip'
      : '<span class="btn-icon">●</span> Start trip';

    ui.pause.disabled = !recording;
    ui.stop.disabled = !trip;
    ui.markStop.disabled = !recording || !trip.points.length;

    if (ui.chip) {
      ui.chip.style.display = recording ? 'block' : 'none';
      if (recording) {
        ui.chip.innerHTML =
          '<span class="tr-recording-dot"></span>Recording • ' +
          distanceKm.toFixed(2) + ' km • ' + formatDuration(elapsedMs(trip));
      }
    }

    if (position && position.coords && Number.isFinite(position.coords.speed)) {
      lastPosition = position;
    }
  }

  function clearMapLayer(layer) {
    const m = safeMap();
    if (!m || !layer) return;
    try {
      m.removeLayer(layer);
    } catch (error) {
      console.debug('Could not remove recorder map layer.', error);
    }
  }

  function renderCurrentTrack() {
    const m = safeMap();
    const leaflet = safeLeaflet();
    if (!m || !leaflet || !activeTrip) return;

    const latlngs = activeTrip.points.map(function (point) {
      return [point.lat, point.lng];
    });

    if (!currentTrackLayer) {
      currentTrackLayer = leaflet.polyline(latlngs, {
        color: '#ef4444',
        weight: 5,
        opacity: 0.9
      }).addTo(m);
    } else {
      currentTrackLayer.setLatLngs(latlngs);
    }

    renderCurrentMarkers();
  }

  function renderCurrentMarkers() {
    const m = safeMap();
    const leaflet = safeLeaflet();
    if (!m || !leaflet || !activeTrip) return;

    clearMapLayer(currentMarkerLayer);
    currentMarkerLayer = leaflet.layerGroup().addTo(m);

    if (activeTrip.points.length) {
      const first = activeTrip.points[0];
      leaflet.circleMarker([first.lat, first.lng], {
        radius: 7,
        color: '#22c55e',
        fillOpacity: 1
      }).bindTooltip('Trip start').addTo(currentMarkerLayer);

      const last = activeTrip.points[activeTrip.points.length - 1];
      leaflet.circleMarker([last.lat, last.lng], {
        radius: 6,
        color: '#ef4444',
        fillOpacity: 1
      }).bindTooltip('Current position').addTo(currentMarkerLayer);
    }

    activeTrip.stops.forEach(function (stop) {
      leaflet.circleMarker([stop.lat, stop.lng], {
        radius: 6,
        color: '#f59e0b',
        fillOpacity: 1
      }).bindTooltip(stop.label || ('Stop ' + stop.number)).addTo(currentMarkerLayer);
    });
  }

  async function restoreActiveTrip() {
    try {
      const saved = await idbGet('state', ACTIVE_KEY);
      if (!saved) return;

      activeTrip = saved;

      if (activeTrip.status === 'recording') {
        activeTrip.status = 'interrupted';
        activeTrip.pauseStartedAt = activeTrip.pauseStartedAt || isoNow();
        await persistActive(true);
      }

      renderCurrentTrack();
      updateLiveUi();

      const count = Array.isArray(activeTrip.points) ? activeTrip.points.length : 0;
      setRecorderStatus(
        'An unfinished trip was recovered with ' + count + ' GPS points. Press Resume trip to continue, or Stop & save to close it.',
        'warning'
      );
      setGpsStatus('Recovered trip is not recording until you press Resume.');
    } catch (error) {
      console.error('Could not restore unfinished trip.', error);
      setRecorderStatus('Could not restore the previous unfinished trip.', 'error');
    }
  }

  async function refreshHistory(preselectId) {
    try {
      tripCache = await idbGetAllTrips();
    } catch (error) {
      console.error('Could not load trip history.', error);
      tripCache = [];
    }

    if (!ui.history) return;

    ui.history.innerHTML = '';

    if (!tripCache.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No saved trips yet';
      ui.history.appendChild(option);
    } else {
      tripCache.forEach(function (trip) {
        const option = document.createElement('option');
        option.value = trip.id;
        option.textContent =
          formatLocalDateTime(trip.startedAt) +
          ' • ' + (Number(trip.distanceM || 0) / 1000).toFixed(2) + ' km';
        ui.history.appendChild(option);
      });
    }

    if (preselectId && tripCache.some(function (trip) { return trip.id === preselectId; })) {
      ui.history.value = preselectId;
    }

    updateSelectedTripSummary();
  }

  function selectedTrip() {
    if (!ui.history || !ui.history.value) return null;
    return tripCache.find(function (trip) { return trip.id === ui.history.value; }) || null;
  }

  function updateSelectedTripSummary() {
    const trip = selectedTrip();
    const enabled = Boolean(trip);

    [ui.show, ui.gpx, ui.geojson, ui.csv, ui.delete].forEach(function (button) {
      if (button) button.disabled = !enabled;
    });

    if (!trip) {
      if (ui.historySummary) {
        ui.historySummary.textContent = 'Trips are stored locally in this browser using IndexedDB.';
      }
      return;
    }

    const actualKm = Number(trip.distanceM || 0) / 1000;
    const duration = formatDuration(elapsedMs(trip, trip.endedAt ? Date.parse(trip.endedAt) : Date.now()));
    const parts = [
      actualKm.toFixed(2) + ' km actual',
      duration,
      (trip.points || []).length + ' GPS points',
      (trip.stops || []).length + ' marked stops'
    ];

    if (Number.isFinite(trip.plannedDistanceKm)) {
      const variance = actualKm - trip.plannedDistanceKm;
      parts.push(
        trip.plannedDistanceKm.toFixed(2) + ' km planned',
        (variance >= 0 ? '+' : '') + variance.toFixed(2) + ' km variance'
      );
    }

    ui.historySummary.textContent = parts.join(' • ');
  }

  function showSelectedTrip() {
    const trip = selectedTrip();
    if (trip) showTripOnMap(trip);
  }

  function showTripOnMap(trip) {
    const m = safeMap();
    const leaflet = safeLeaflet();
    if (!m || !leaflet || !trip || !Array.isArray(trip.points) || !trip.points.length) return;

    clearMapLayer(historyLayer);
    historyLayer = leaflet.layerGroup().addTo(m);

    const latlngs = trip.points.map(function (point) {
      return [point.lat, point.lng];
    });

    const line = leaflet.polyline(latlngs, {
      color: '#f97316',
      weight: 6,
      opacity: 0.9
    }).addTo(historyLayer);

    const first = trip.points[0];
    const last = trip.points[trip.points.length - 1];

    leaflet.circleMarker([first.lat, first.lng], {
      radius: 7,
      color: '#22c55e',
      fillOpacity: 1
    }).bindTooltip('Start ' + formatLocalDateTime(trip.startedAt)).addTo(historyLayer);

    leaflet.circleMarker([last.lat, last.lng], {
      radius: 7,
      color: '#ef4444',
      fillOpacity: 1
    }).bindTooltip('End ' + formatLocalDateTime(trip.endedAt)).addTo(historyLayer);

    (trip.stops || []).forEach(function (stop) {
      leaflet.circleMarker([stop.lat, stop.lng], {
        radius: 6,
        color: '#f59e0b',
        fillOpacity: 1
      }).bindTooltip(stop.label || ('Stop ' + stop.number)).addTo(historyLayer);
    });

    try {
      const bounds = line.getBounds();
      if (bounds && bounds.isValid()) {
        m.fitBounds(bounds.pad(0.15));
      }
    } catch (error) {
      console.debug('Could not fit trip track bounds.', error);
    }
  }

  async function deleteSelectedTrip() {
    const trip = selectedTrip();
    if (!trip) return;

    const ok = window.confirm(
      'Delete the saved trip from ' + formatLocalDateTime(trip.startedAt) + '? This cannot be undone.'
    );
    if (!ok) return;

    await idbDelete('trips', trip.id);
    clearMapLayer(historyLayer);
    historyLayer = null;
    await refreshHistory();
  }

  function fileSafeTimestamp(iso) {
    const date = new Date(iso || Date.now());
    return date.toISOString().replace(/[:.]/g, '-');
  }

  function xmlEscape(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function tripToGpx(trip) {
    const title = 'WayPoint trip ' + formatLocalDateTime(trip.startedAt);
    const waypoints = (trip.stops || []).map(function (stop) {
      return (
        '<wpt lat="' + stop.lat.toFixed(7) + '" lon="' + stop.lng.toFixed(7) + '">' +
          '<time>' + xmlEscape(stop.timestamp) + '</time>' +
          '<name>' + xmlEscape(stop.label || ('Stop ' + stop.number)) + '</name>' +
        '</wpt>'
      );
    }).join('\n');

    const points = (trip.points || []).map(function (point) {
      let extensions = '';
      const ext = [];

      if (Number.isFinite(point.accuracy)) {
        ext.push('<waypoint:accuracyM>' + Number(point.accuracy).toFixed(1) + '</waypoint:accuracyM>');
      }
      if (Number.isFinite(point.speedMps)) {
        ext.push('<waypoint:speedMps>' + Number(point.speedMps).toFixed(3) + '</waypoint:speedMps>');
      }
      if (Number.isFinite(point.cumulativeM)) {
        ext.push('<waypoint:cumulativeM>' + Number(point.cumulativeM).toFixed(1) + '</waypoint:cumulativeM>');
      }
      if (ext.length) {
        extensions = '<extensions>' + ext.join('') + '</extensions>';
      }

      return (
        '<trkpt lat="' + point.lat.toFixed(7) + '" lon="' + point.lng.toFixed(7) + '">' +
          (Number.isFinite(point.altitude) ? '<ele>' + Number(point.altitude).toFixed(2) + '</ele>' : '') +
          '<time>' + xmlEscape(point.timestamp) + '</time>' +
          extensions +
        '</trkpt>'
      );
    }).join('\n');

    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="WayPoint Trip Recorder" ' +
        'xmlns="http://www.topografix.com/GPX/1/1" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xmlns:waypoint="https://astroaflabs.github.io/waypoint/extensions/1">\n' +
        '<metadata><name>' + xmlEscape(title) + '</name><time>' + xmlEscape(trip.startedAt) + '</time></metadata>\n' +
        waypoints + '\n' +
        '<trk><name>' + xmlEscape(title) + '</name><trkseg>\n' +
          points + '\n' +
        '</trkseg></trk>\n' +
      '</gpx>\n'
    );
  }

  function tripToGeoJson(trip) {
    const coordinates = (trip.points || []).map(function (point) {
      return Number.isFinite(point.altitude)
        ? [point.lng, point.lat, point.altitude]
        : [point.lng, point.lat];
    });

    const featureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            kind: 'actual-trip-track',
            id: trip.id,
            startedAt: trip.startedAt,
            endedAt: trip.endedAt,
            actualDistanceKm: Number(trip.distanceM || 0) / 1000,
            plannedDistanceKm: Number.isFinite(trip.plannedDistanceKm) ? trip.plannedDistanceKm : null,
            durationMs: elapsedMs(trip, trip.endedAt ? Date.parse(trip.endedAt) : Date.now()),
            pointTimes: (trip.points || []).map(function (point) { return point.timestamp; }),
            accuracyM: (trip.points || []).map(function (point) { return point.accuracy; }),
            speedMps: (trip.points || []).map(function (point) { return point.speedMps; }),
            cumulativeM: (trip.points || []).map(function (point) { return point.cumulativeM; }),
            notes: trip.notes || ''
          },
          geometry: {
            type: 'LineString',
            coordinates: coordinates
          }
        }
      ]
    };

    (trip.stops || []).forEach(function (stop) {
      featureCollection.features.push({
        type: 'Feature',
        properties: {
          kind: 'marked-stop',
          number: stop.number,
          label: stop.label,
          timestamp: stop.timestamp,
          cumulativeM: stop.cumulativeM
        },
        geometry: {
          type: 'Point',
          coordinates: [stop.lng, stop.lat]
        }
      });
    });

    return JSON.stringify(featureCollection, null, 2);
  }

  function csvCell(value) {
    const text = String(value === null || value === undefined ? '' : value);
    if (/[",\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function tripToCsv(trip) {
    const rows = [
      [
        'timestamp',
        'latitude',
        'longitude',
        'accuracy_m',
        'altitude_m',
        'speed_kmh',
        'heading_deg',
        'cumulative_km'
      ].join(',')
    ];

    (trip.points || []).forEach(function (point) {
      rows.push([
        csvCell(point.timestamp),
        csvCell(point.lat),
        csvCell(point.lng),
        csvCell(point.accuracy),
        csvCell(point.altitude),
        csvCell(Number.isFinite(point.speedMps) ? (point.speedMps * 3.6).toFixed(2) : ''),
        csvCell(point.heading),
        csvCell((Number(point.cumulativeM || 0) / 1000).toFixed(4))
      ].join(','));
    });

    return rows.join('\n') + '\n';
  }

  function downloadText(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  function exportSelectedTrip(format) {
    const trip = selectedTrip();
    if (!trip) return;

    const stamp = fileSafeTimestamp(trip.startedAt);
    if (format === 'gpx') {
      downloadText('waypoint-trip-' + stamp + '.gpx', tripToGpx(trip), 'application/gpx+xml');
    } else if (format === 'geojson') {
      downloadText('waypoint-trip-' + stamp + '.geojson', tripToGeoJson(trip), 'application/geo+json');
    } else if (format === 'csv') {
      downloadText('waypoint-trip-' + stamp + '.csv', tripToCsv(trip), 'text/csv');
    }
  }

  function handleVisibilityChange() {
    if (!activeTrip || activeTrip.status !== 'recording') return;

    if (document.visibilityState === 'hidden') {
      setRecorderStatus(
        'WayPoint is in the background. Android may suspend browser GPS; keep this screen visible for reliable route logging.',
        'warning'
      );
    } else {
      requestWakeLock().catch(function () {});
      setRecorderStatus('Recording actual route. GPS points are being saved locally.', 'recording');
    }
  }

  async function initialize() {
    ensureUi();

    try {
      await openDb();
    } catch (error) {
      handleFatalUiError(
        new Error('This browser cannot open local trip storage. Recording is disabled.')
      );
      if (ui.start) ui.start.disabled = true;
      return;
    }

    await restoreActiveTrip();
    await refreshHistory();

    document.addEventListener('visibilitychange', handleVisibilityChange);

    window.addEventListener('pagehide', function () {
      if (activeTrip) {
        persistActive(true).catch(function () {});
      }
    });

    window.addEventListener('beforeunload', function () {
      if (activeTrip) {
        persistActive(true).catch(function () {});
      }
    });

    updateLiveUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initialize().catch(handleFatalUiError);
    }, { once: true });
  } else {
    initialize().catch(handleFatalUiError);
  }
})();

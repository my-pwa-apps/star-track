// ============================================================
// app.js  –  Star Track main application controller
// ============================================================

(function () {
  'use strict';

  // ── DOM references ─────────────────────────────────────────
  const canvas           = document.getElementById('sky-canvas');
  const statusEl         = document.getElementById('status-bar');
  const searchInput      = document.getElementById('search-input');
  const searchResults    = document.getElementById('search-results');
  const searchBar        = document.getElementById('search-bar');
  const infoPanel        = document.getElementById('info-panel');
  const infoPanelBody    = document.getElementById('info-panel-body');
  const ipObjectName     = document.getElementById('ip-object-name');
  const btnAR            = document.getElementById('btn-ar');
  const btnMap           = document.getElementById('btn-map');
  const btnLocate        = document.getElementById('btn-locate');
  const btnSearchToggle  = document.getElementById('btn-search-toggle');
  const timeDisplay      = document.getElementById('time-display');
  const stardateDisplay  = document.getElementById('stardate-display');
  const locationDisplay  = document.getElementById('location-display');
  const sidebarStatus    = document.getElementById('sidebar-status-text');
  const arReadout        = document.getElementById('ar-readout');
  const arAzEl           = document.getElementById('ar-az');
  const arAltEl          = document.getElementById('ar-alt');
  const arModeLabel      = document.getElementById('ar-mode-label');

  // Checkboxes / sliders (in LCARS sidebar)
  const chkLines     = document.getElementById('chk-lines');
  const chkLabels    = document.getElementById('chk-labels');
  const chkNames     = document.getElementById('chk-names');
  const chkGrid      = document.getElementById('chk-grid');
  const sliderMag    = document.getElementById('slider-mag');
  const sliderMagVal = document.getElementById('slider-mag-val');

  // ── State ──────────────────────────────────────────────────
  let lat = 52.0, lon = 5.0;   // default: Netherlands
  let renderer;
  let animHandle;
  let lastComputeTime  = 0;
  let lastClockSecond  = -1;    // rate-limit time display to 1×/s
  let searchIndexCache = null;  // invalidated after computePositions
  let orientation = { alpha: null, beta: null, gamma: null };
  let useDeviceOrientation = false;
  let compassAlpha = null; // smoothed azimuth
  let smoothBeta    = null; // smoothed tilt   (altitude)
  let smoothGamma   = null; // smoothed roll   (az correction)
  // Previous raw sensor values used to compute per-frame angular velocity
  let prevRawAlpha  = null;
  let prevRawBeta   = null;
  let prevRawGamma  = null;
  let wakeLock      = null; // Screen Wake Lock handle

  // ── Init ───────────────────────────────────────────────────
  function init() {
    renderer = new SkyRenderer(canvas);
    renderer.constellations = CONSTELLATIONS;

    setupSettings();
    setupSearch();
    setupFilterButtons();
    setupCanvasInteraction();
    setupResizeObserver();

    renderer.resize();
    requestGeolocation();
    requestWakeLock();
    startLoop();

    btnAR.addEventListener('click',           switchToAR);
    btnMap.addEventListener('click',          switchToMap);
    btnLocate.addEventListener('click',       requestGeolocation);
    btnSearchToggle.addEventListener('click', toggleSearchBar);
    document.getElementById('search-close').addEventListener('click', closeSearchBar);

    // Pause rendering when tab is hidden, resume on return
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(animHandle);
        // Wake lock releases automatically when hidden — that’s fine
      } else {
        lastComputeTime = 0; // force immediate recompute
        startLoop();
        requestWakeLock();  // re-acquire after returning to tab
      }
    });

    // Mode default
    switchToMap();

    // Keyboard shortcuts
    document.addEventListener('keydown', onKeyDown);

    // PWA: service worker + install/update prompts
    setupPWA();
  }

  // ── Keyboard shortcuts ────────────────────────────────────
  function onKeyDown(e) {
    // Ignore when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key.toLowerCase()) {
      case 'm': switchToMap();                    break;
      case 'a': switchToAR();                     break;
      case 'g': chkGrid.checked = !chkGrid.checked;
                renderer.showGrid = chkGrid.checked;
                syncToggle(chkGrid);              break;
      case 'c': chkLines.checked = !chkLines.checked;
                renderer.showConstellationLines = chkLines.checked;
                syncToggle(chkLines);             break;
      case 'n': chkNames.checked = !chkNames.checked;
                renderer.showStarNames = chkNames.checked;
                syncToggle(chkNames);             break;
      case 'l': chkLabels.checked = !chkLabels.checked;
                renderer.showConstellationLabels = chkLabels.checked;
                syncToggle(chkLabels);            break;
      case 'escape':
        if (!searchBar.classList.contains('hidden')) { closeSearchBar(); break; }
        if (!infoPanel.classList.contains('hidden')) {
          infoPanel.classList.add('hidden');
          renderer.selected = null;
          renderer.highlightTarget = null;
        }
        break;
      case '/': case 'f':
        if (e.ctrlKey || e.metaKey) return; // let browser handle Ctrl+F
        e.preventDefault();
        toggleSearchBar();
        break;
    }
  }

  // ── Screen Wake Lock ──────────────────────────────────────────
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return; // API not available (HTTP or older browser)
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (err) {
      // Non-critical — fails silently (e.g. low battery lockout)
    }
  }

  // ── PWA: Service Worker + Install / Update prompts ────────────
  function setupPWA() {
    if (!('serviceWorker' in navigator)) return;

    let deferredInstallPrompt = null;

    const installBanner  = document.getElementById('pwa-install-banner');
    const updateBanner   = document.getElementById('pwa-update-banner');
    const installBtn     = document.getElementById('pwa-install-btn');
    const installDismiss = document.getElementById('pwa-install-dismiss');
    const updateBtn      = document.getElementById('pwa-update-btn');
    const updateDismiss  = document.getElementById('pwa-update-dismiss');

    // ── Register the service worker ──────────────────────────
    let swRegistration = null;

    navigator.serviceWorker.register('sw.js').then(reg => {
      swRegistration = reg;

      // A new SW is waiting to take over → show update banner
      if (reg.waiting) showUpdateBanner(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(newSW);
          }
        });
      });
    }).catch(err => console.warn('SW registration failed:', err));

    // Check for SW updates when the user returns to the tab
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && swRegistration) swRegistration.update();
    });

    // Reload once the new SW has taken control
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });

    // ── Install prompt ────────────────────────────────────────
    const DISMISS_KEY = 'pwa-install-dismissed';

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (!localStorage.getItem(DISMISS_KEY)) {
        showBanner(installBanner);
      }
    });

    installBtn.addEventListener('click', async () => {
      hideBanner(installBanner);
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') deferredInstallPrompt = null;
    });

    installDismiss.addEventListener('click', () => {
      hideBanner(installBanner);
      localStorage.setItem(DISMISS_KEY, '1');
    });

    // ── Update prompt ─────────────────────────────────────────
    function showUpdateBanner(sw) {
      showBanner(updateBanner);
      updateBtn.addEventListener('click', () => {
        hideBanner(updateBanner);
        sw.postMessage({ type: 'SKIP_WAITING' });
      }, { once: true });
    }

    updateDismiss.addEventListener('click', () => hideBanner(updateBanner));

    // ── Helpers ───────────────────────────────────────────────
    function showBanner(el) { el.classList.remove('hidden'); }
    function hideBanner(el) { el.classList.add('hidden'); }
  }

  // ── Resize observer ───────────────────────────────────────
  function setupResizeObserver() {
    const ro = new ResizeObserver(() => { renderer.resize(); });
    ro.observe(canvas);
  }

  // ── Animation loop ─────────────────────────────────────────
  function startLoop() {
    function frame(ts) {
      animHandle = requestAnimationFrame(frame);
      const now = Date.now();
      if (now - lastComputeTime > 30000) { // recompute every 30 s (positions change slowly)
        computePositions(now);
        lastComputeTime = now;
      }
      if (useDeviceOrientation) {
        applyDeviceOrientation();
      }
      renderer.date = new Date();
      renderer.render();

      // Clock: update once per second
      const nowSec = Math.floor(now / 1000);
      if (nowSec !== lastClockSecond) {
        lastClockSecond = nowSec;
        updateTimeDisplay();
      }

      if (renderer.mode === 'ar') {
        arAzEl.textContent  = formatAz(renderer.viewAz);
        arAltEl.textContent = formatAlt(renderer.viewAlt);
        arModeLabel.textContent = useDeviceOrientation ? 'SENSOR' : 'MANUAL';
      }
    }
    animHandle = requestAnimationFrame(frame);
  }

  // ── Compute all sky object positions ───────────────────────
  function computePositions(now) {
    const date = new Date(now);
    renderer.lat  = lat;
    renderer.lon  = lon;
    renderer.date = date;

    // Stars with Alt/Az
    renderer.stars = STARS.map(s => {
      const { alt, az } = raDecToAltAz(s.ra, s.dec, lat, lon, date);
      return { ...s, alt, az };
    });

    // Constellations with Alt/Az + precomputed label centroid
    renderer.constellations = CONSTELLATIONS.map(c => {
      const lines = c.lines.map(([ra1, dec1, ra2, dec2]) => {
        const a1 = raDecToAltAz(ra1, dec1, lat, lon, date);
        const a2 = raDecToAltAz(ra2, dec2, lat, lon, date);
        return { a1, a2 };
      });
      // Precompute centroid for label placement
      let sumAlt = 0, sumAzX = 0, sumAzY = 0, n = 0;
      for (const { a1, a2 } of lines) {
        sumAlt += a1.alt + a2.alt;
        sumAzX += Math.cos(a1.az * DEG) + Math.cos(a2.az * DEG);
        sumAzY += Math.sin(a1.az * DEG) + Math.sin(a2.az * DEG);
        n += 2;
      }
      const labelAlt = n > 0 ? sumAlt / n : 0;
      const labelAz  = n > 0 ? Math.atan2(sumAzY, sumAzX) * RAD : 0;
      return { ...c, computedLines: lines, labelAlt, labelAz };
    });

    // Planets & Sun/Moon (need astronomy-engine loaded)
    if (typeof Astronomy !== 'undefined') {
      renderer.planets = getPlanets(lat, lon, date);
      renderer.sunMoon = getSunMoon(lat, lon, date);
    }

    searchIndexCache = null; // invalidate so search rebuilds with fresh positions
  }

  // ── Geolocation ────────────────────────────────────────────
  function requestGeolocation() {
    setStatus('Requesting location…');
    if (!navigator.geolocation) {
      setStatus('Geolocation unavailable – using default (Netherlands)');
      computePositions(Date.now());
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
        const locStr = `${Math.abs(lat).toFixed(2)}° ${lat>=0?'N':'S'} · ${Math.abs(lon).toFixed(2)}° ${lon>=0?'E':'W'}`;
        if (locationDisplay) locationDisplay.textContent = locStr;
        setStatus('LOCATION ACQUIRED');
        computePositions(Date.now());
        lastComputeTime = Date.now();
        setTimeout(() => setStatus(''), 3000);
      },
      err => {
        setStatus(`Location error: ${err.message}. Using default.`);
        computePositions(Date.now());
        setTimeout(() => setStatus(''), 4000);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // ── Device Orientation (AR mode) ──────────────────────────
  function requestDeviceOrientation() {
    // iOS 13+ requires explicit permission
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(status => {
          if (status === 'granted') {
            window.addEventListener('deviceorientationabsolute', onOrientation, true);
            window.addEventListener('deviceorientation', onOrientation, true);
          } else {
            setStatus('Orientation permission denied – AR unavailable');
          }
        })
        .catch(console.error);
    } else {
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
    }
  }

  function onOrientation(e) {
    // Prefer absolute (gives true N), fall back to relative
    if (e.type === 'deviceorientation' && e.absolute === true) return; // handled by absolute
    orientation.alpha = e.alpha ?? orientation.alpha;
    orientation.beta  = e.beta  ?? orientation.beta;
    orientation.gamma = e.gamma ?? orientation.gamma;
  }

  function applyDeviceOrientation() {
    if (orientation.alpha === null) return;

    // Adaptive LERP — scales with angular velocity so the view stays rock
    // steady when held still (noise rejected) yet snaps instantly when panning
    //   LERP_MIN : used when nearly stationary  → tight noise rejection
    //   LERP_MAX : used at fast deliberate sweeps → full responsiveness
    //   VEL_FULL : °/frame velocity that saturates to LERP_MAX
    const LERP_MIN = 0.012;
    const LERP_MAX = 0.20;
    const VEL_FULL = 5.0; // degrees per frame
    const DEADBAND_A = 0.18;
    const DEADBAND_B = 0.12;
    const DEADBAND_G = 0.18;
    const SPIKE_A = 35;
    const SPIKE_B = 25;
    const SPIKE_G = 35;

    const targetAlpha = orientation.alpha;
    const targetBeta  = orientation.beta  ?? 135; // default to looking up at 45°
    const targetGamma = orientation.gamma ?? 0;

    // ─ Per-axis instantaneous velocity (degrees since last frame) ─
    let velA = 0, velB = 0, velG = 0;
    if (prevRawAlpha !== null) {
      let da = targetAlpha - prevRawAlpha;
      if (da >  180) da -= 360;          // shortest arc
      if (da < -180) da += 360;
      if (Math.abs(da) > SPIKE_A) da = 0;
      velA = Math.abs(da);
    }
    if (prevRawBeta  !== null) {
      let db = targetBeta - prevRawBeta;
      if (Math.abs(db) > SPIKE_B) db = 0;
      velB = Math.abs(db);
    }
    if (prevRawGamma !== null) {
      let dg = targetGamma - prevRawGamma;
      if (Math.abs(dg) > SPIKE_G) dg = 0;
      velG = Math.abs(dg);
    }
    prevRawAlpha = targetAlpha;
    prevRawBeta  = targetBeta;
    prevRawGamma = targetGamma;

    // ─ Adaptive lerp factors, one per axis ─
    const lerpA = LERP_MIN + (LERP_MAX - LERP_MIN) * Math.min(velA / VEL_FULL, 1);
    const lerpB = LERP_MIN + (LERP_MAX - LERP_MIN) * Math.min(velB / VEL_FULL, 1);
    const lerpG = LERP_MIN + (LERP_MAX - LERP_MIN) * Math.min(velG / VEL_FULL, 1);

    // ─ Azimuth (alpha) — shortest-arc lerp to avoid 359↔0 wrap jump ─
    if (compassAlpha === null) compassAlpha = targetAlpha;
    let diffA = targetAlpha - compassAlpha;
    if (diffA >  180) diffA -= 360;
    if (diffA < -180) diffA += 360;
    if (Math.abs(diffA) < DEADBAND_A) diffA = 0;
    compassAlpha = (compassAlpha + diffA * lerpA + 360) % 360;

    // ─ Tilt / altitude (beta) ─
    if (smoothBeta === null) smoothBeta = targetBeta;
    let diffB = targetBeta - smoothBeta;
    if (Math.abs(diffB) < DEADBAND_B) diffB = 0;
    smoothBeta += diffB * lerpB;

    // ─ Roll correction (gamma) ─
    if (smoothGamma === null) smoothGamma = targetGamma;
    let diffG = targetGamma - smoothGamma;
    if (Math.abs(diffG) < DEADBAND_G) diffG = 0;
    smoothGamma += diffG * lerpG;

    // altitude = beta - 90 (beta=90 → horizon, beta=180 → zenith, beta=0 → nadir)
    const alt = Math.max(-90, Math.min(90, smoothBeta - 90));

    // azimuth + small roll correction
    const az  = ((compassAlpha + smoothGamma * 0.5) % 360 + 360) % 360;

    renderer.viewAz  = az;
    renderer.viewAlt = alt;
  }

  // ── Mode switching ─────────────────────────────────────────
  function switchToMap() {
    renderer.mode = 'map';
    btnMap.classList.add('active');
    btnAR.classList.remove('active');
    useDeviceOrientation = false;
    // Reset smoothed sensor state so next AR entry starts clean
    compassAlpha = null;
    smoothBeta   = null;
    smoothGamma  = null;
    prevRawAlpha = null;
    prevRawBeta  = null;
    prevRawGamma = null;
    if (arReadout) arReadout.classList.add('hidden');
    setSidebarStatus('MAP MODE ACTIVE');
    setStatus('');
  }

  function switchToAR() {
    renderer.mode = 'ar';
    btnAR.classList.add('active');
    btnMap.classList.remove('active');
    if (arReadout) arReadout.classList.remove('hidden');

    // Try to activate device orientation
    useDeviceOrientation = true;
    requestDeviceOrientation();
    setSidebarStatus('AR MODE ACTIVE');
    setStatus('POINT DEVICE AT SKY ↑');
    setTimeout(() => {
      if (orientation.alpha === null) {
        setStatus('SENSORS UNAVAILABLE – DRAG TO NAVIGATE');
        setSidebarStatus('NO SENSOR DATA');
      } else {
        setStatus('');
        setSidebarStatus('SENSOR LOCK');
      }
    }, 2000);
  }

  // ── Search bar visibility ──────────────────────────────────
  function toggleSearchBar() {
    const isNowOpen = searchBar.classList.toggle('hidden') === false;
    if (isNowOpen) searchInput.focus();
  }

  function closeSearchBar() {
    searchBar.classList.add('hidden');
    searchResults.classList.add('hidden');
    searchInput.value = '';
  }

  function setupSearch() {
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('focus', onSearchInput);
    document.addEventListener('click', e => {
      if (!searchBar.contains(e.target) && e.target !== btnSearchToggle) {
        searchResults.classList.add('hidden');
      }
    });
  }

  function onSearchInput() {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) { searchResults.classList.add('hidden'); return; }

    const allObjects = buildSearchIndex();
    const matches = allObjects.filter(o =>
      o.name.toLowerCase().includes(q) ||
      (o.abbr && o.abbr.toLowerCase().includes(q))
    ).slice(0, 12);

    if (matches.length === 0) {
      searchResults.innerHTML = '<div class="search-item no-result">No results</div>';
    } else {
      searchResults.innerHTML = matches.map(m => `
        <div class="search-item" data-id="${m.id}" data-type="${m.type}">
          <span class="search-icon">${m.icon}</span>
          <span class="search-name">${m.name}</span>
          <span class="search-meta">${m.meta}</span>
        </div>
      `).join('');
      searchResults.querySelectorAll('.search-item').forEach(el => {
        el.addEventListener('click', () => selectFromSearch(el, matches));
      });
    }
    searchResults.classList.remove('hidden');
  }

  function buildSearchIndex() {
    if (searchIndexCache) return searchIndexCache;
    const items = [];
    // Stars
    for (const s of renderer.stars) {
      if (s.name && s.name !== '') {
        items.push({
          id: s.name, type: 'star', icon: '★',
          name: s.name, abbr: '',
          meta: `mag ${s.mag.toFixed(1)} · ${s.con}`,
          obj: s,
        });
      }
    }
    // Planets
    for (const p of renderer.planets) {
      const magStr = p.mag !== null ? ` · mag ${p.mag.toFixed(1)}` : '';
      items.push({
        id: p.name, type: 'planet', icon: p.symbol,
        name: p.name, abbr: '',
        meta: (p.alt > 0 ? `Alt ${formatAlt(p.alt)}` : 'Below horizon') + magStr,
        obj: p,
      });
    }
    // Sun/Moon
    for (const sm of renderer.sunMoon) {
      items.push({
        id: sm.name, type: sm.type, icon: sm.symbol,
        name: sm.name, abbr: '',
        meta: sm.alt > 0 ? `Alt ${formatAlt(sm.alt)}` : 'Below horizon',
        obj: sm,
      });
    }
    // Constellations
    for (const c of CONSTELLATIONS) {
      items.push({
        id: c.abbr, type: 'constellation', icon: '⊹',
        name: c.name, abbr: c.abbr,
        meta: `Constellation`,
        obj: c,
      });
    }
    searchIndexCache = items;
    return items;
  }

  function selectFromSearch(el, matches) {
    const match = matches.find(m => m.id === el.dataset.id && m.type === el.dataset.type);
    if (!match) return;
    searchResults.classList.add('hidden');
    searchInput.value = match.name;
    selectObject(match.obj, match.type);
  }

  // ── Object Selection ───────────────────────────────────────
  function selectObject(obj, type) {
    renderer.selected = obj;

    let alt, az, title, details;

    if (type === 'constellation') {
      // Centre on constellation centroid
      let sumRa = 0, sumDec = 0, n = 0;
      for (const [ra1,dec1,ra2,dec2] of (obj.lines || [])) {
        sumRa += ra1+ra2; sumDec += dec1+dec2; n += 2;
      }
      if (n > 0) {
        const pos = raDecToAltAz(sumRa/n, sumDec/n, lat, lon, renderer.date);
        alt = pos.alt; az = pos.az;
      }
      title   = obj.name;
      details = `<p>Constellation</p><p>Abbreviation: <b>${obj.abbr}</b></p>`;
      if (alt !== undefined) {
        details += `<p>Altitude: <b>${formatAlt(alt)}</b></p>
                    <p>Azimuth: <b>${formatAz(az)}</b></p>`;
      }
    } else if (type === 'star') {
      alt = obj.alt; az = obj.az;
      title   = obj.name;
      details = `
        <p>Spectral type: <b>${obj.spectral}</b></p>
        <p>Magnitude: <b>${obj.mag.toFixed(2)}</b></p>
        <p>Constellation: <b>${obj.con}</b></p>
        <p>RA: <b>${formatRA(obj.ra)}</b>  Dec: <b>${formatDec(obj.dec)}</b></p>
        <p>Altitude: <b>${formatAlt(alt)}</b></p>
        <p>Azimuth: <b>${formatAz(az)}</b></p>
        <p class="${alt > 0 ? 'visible' : 'not-visible'}">${alt > 0 ? '✓ Visible now' : '✗ Below horizon'}</p>
      `;
    } else if (type === 'planet' || type === 'sun' || type === 'moon') {
      alt = obj.alt; az = obj.az;
      title = `${obj.symbol} ${obj.name}`;
      let extra = '';
      if (obj.mag !== undefined && obj.mag !== null) {
        extra += `<p>Visual magnitude: <b>${obj.mag.toFixed(2)}</b></p>`;
      }
      if (type === 'moon' && obj.phase !== undefined) {
        extra = `<p>Phase: <b>${moonPhaseName(obj.phase)}</b> (${Math.round(obj.phase)}°)</p>`;
      }
      if (typeof Astronomy !== 'undefined') {
        const rs = getRiseSet(obj.name, lat, lon, renderer.date);
        extra += `<p>Rises: <b>${rs.rise}</b>  Sets: <b>${rs.set}</b></p>`;
      }
      details = `
        <p>RA: <b>${formatRA(obj.ra)}</b>  Dec: <b>${formatDec(obj.dec)}</b></p>
        <p>Altitude: <b>${formatAlt(alt)}</b></p>
        <p>Azimuth: <b>${formatAz(az)}</b></p>
        ${extra}
        <p class="${alt > 0 ? 'visible' : 'not-visible'}">${alt > 0 ? '✓ Visible now' : '✗ Below horizon'}</p>
      `;
    }

    // Set highlight target
    if (alt !== undefined && az !== undefined) {
      renderer.highlightTarget = { alt, az };
      // In AR mode, centre the view on the object
      if (renderer.mode === 'ar') {
        renderer.viewAz  = az;
        renderer.viewAlt = Math.max(0, alt);
        useDeviceOrientation = false; // pause sensor for a moment
        setTimeout(() => { if (renderer.mode === 'ar') useDeviceOrientation = true; }, 3000);
      }
    }

    // Show info panel
    infoPanelBody.innerHTML = `<h3>${title}</h3>${details}`;
    if (ipObjectName) ipObjectName.textContent = title;
    infoPanel.classList.remove('hidden');
  }

  // ── Canvas tap / click ─────────────────────────────────────
  function setupCanvasInteraction() {
    let touchStartX, touchStartY, touchStartTime;
    let dragLastX, dragLastY;
    let isDragging = false;

    canvas.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      dragLastX    = touchStartX;
      dragLastY    = touchStartY;
    }, { passive: true });

    canvas.addEventListener('touchmove', e => {
      if (renderer.mode === 'ar') {
        const dx = e.touches[0].clientX - dragLastX;
        const dy = e.touches[0].clientY - dragLastY;
        dragLastX = e.touches[0].clientX;
        dragLastY = e.touches[0].clientY;
        renderer.viewAz  = ((renderer.viewAz  - dx * 0.3) % 360 + 360) % 360;
        renderer.viewAlt = Math.max(-90, Math.min(90, renderer.viewAlt + dy * 0.3));
        isDragging = true;
      }
    }, { passive: true });

    canvas.addEventListener('touchend', e => {
      const dx   = e.changedTouches[0].clientX - touchStartX;
      const dy   = e.changedTouches[0].clientY - touchStartY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const dt   = Date.now() - touchStartTime;
      if (dist < 10 && dt < 300) {
        // Tap = select
        hitTestAt(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }
      isDragging = false;
    }, { passive: true });

    // Mouse drag (map rotation in map mode, pan in AR mode)
    let mouseDown = false, startMX, startMY, lastMX, lastMY;
    canvas.addEventListener('mousedown', e => {
      mouseDown = true;
      startMX = lastMX = e.clientX;
      startMY = lastMY = e.clientY;
    });
    canvas.addEventListener('mousemove', e => {
      if (!mouseDown) return;
      const dx = e.clientX - lastMX;
      const dy = e.clientY - lastMY;
      lastMX = e.clientX; lastMY = e.clientY;
      if (renderer.mode === 'map') {
        renderer.mapRotation = ((renderer.mapRotation + dx * 0.3) % 360 + 360) % 360;
      } else {
        renderer.viewAz  = ((renderer.viewAz  - dx * 0.4) % 360 + 360) % 360;
        renderer.viewAlt = Math.max(-90, Math.min(90, renderer.viewAlt + dy * 0.4));
        useDeviceOrientation = false;
      }
    });
    canvas.addEventListener('mouseup', e => {
      if (mouseDown) {
        const dx = e.clientX - startMX, dy = e.clientY - startMY;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
          hitTestAt(e.clientX, e.clientY);
        }
      }
      mouseDown = false;
    });
    canvas.addEventListener('mouseout', () => mouseDown = false);

    // Scroll to zoom fov in AR
    canvas.addEventListener('wheel', e => {
      if (renderer.mode === 'ar') {
        renderer.fieldOfView = Math.max(20, Math.min(120, renderer.fieldOfView + e.deltaY * 0.05));
      }
      e.preventDefault();
    }, { passive: false });

    // Close info panel
    document.getElementById('info-panel-close').addEventListener('click', () => {
      infoPanel.classList.add('hidden');
      renderer.selected = null;
      renderer.highlightTarget = null;
    });
  }

  function hitTestAt(x, y) {
    const rect  = canvas.getBoundingClientRect();
    const cx    = x - rect.left;
    const cy    = y - rect.top;
    const W     = canvas.clientWidth;
    const H     = canvas.clientHeight;
    const obj   = renderer.hitTest(cx, cy, W, H);
    if (obj) {
      const type = obj.type || (obj.spectral ? 'star' : 'constellation');
      selectObject(obj, type);
    } else {
      infoPanel.classList.add('hidden');
      renderer.selected = null;
      renderer.highlightTarget = null;
    }
  }

  // ── Sync LCARS toggle visuals with checkbox state ──────────
  function syncToggle(checkbox) {
    // The .t-track element is the next sibling <span> after the checkbox
    const track = checkbox.nextElementSibling;
    if (!track) return;
    track.classList.toggle('on', checkbox.checked);
  }

  // ── Settings (sidebar) ─────────────────────────────────────
  function setupSettings() {
    chkLines.checked   = renderer.showConstellationLines;
    chkLabels.checked  = renderer.showConstellationLabels;
    chkNames.checked   = renderer.showStarNames;
    chkGrid.checked    = renderer.showGrid;
    sliderMag.value    = renderer.limitMag;
    sliderMagVal.textContent = renderer.limitMag.toFixed(1);

    // Initial visual sync for LCARS toggles
    [chkLines, chkLabels, chkNames, chkGrid].forEach(syncToggle);

    chkLines.addEventListener('change', () => {
      renderer.showConstellationLines  = chkLines.checked;
      syncToggle(chkLines);
    });
    chkLabels.addEventListener('change', () => {
      renderer.showConstellationLabels = chkLabels.checked;
      syncToggle(chkLabels);
    });
    chkNames.addEventListener('change', () => {
      renderer.showStarNames = chkNames.checked;
      syncToggle(chkNames);
    });
    chkGrid.addEventListener('change', () => {
      renderer.showGrid = chkGrid.checked;
      syncToggle(chkGrid);
    });
    sliderMag.addEventListener('input', () => {
      renderer.limitMag = parseFloat(sliderMag.value);
      sliderMagVal.textContent = renderer.limitMag.toFixed(1);
    });
  }

  // ── Filter buttons (sidebar + mobile nav) ───────────────────────
  function setupFilterButtons() {
    // Sidebar buttons (desktop)
    document.getElementById('filter-planets').addEventListener('click', () => showQuickList('planets'));
    document.getElementById('filter-stars').addEventListener('click',   () => showQuickList('stars'));
    document.getElementById('filter-constellations').addEventListener('click', () => showQuickList('constellations'));
    document.getElementById('filter-moon').addEventListener('click',    () => showQuickList('moon'));

    // Mobile nav buttons (share data-filter attribute)
    document.getElementById('mobile-nav').addEventListener('click', e => {
      const btn = e.target.closest('[data-filter]');
      if (btn) showQuickList(btn.dataset.filter);
    });
  }

  function showQuickList(category) {
    let items = [];
    if (category === 'planets') {
      items = renderer.planets.map(p => ({ ...p, type: 'planet' }));
      items.push(...renderer.sunMoon.filter(s => s.type === 'sun'));
    } else if (category === 'stars') {
      items = renderer.stars.filter(s => s.name).sort((a,b) => a.mag - b.mag).slice(0, 15);
      items = items.map(s => ({ ...s, type: 'star' }));
    } else if (category === 'constellations') {
      items = CONSTELLATIONS.map(c => ({ ...c, type: 'constellation', name: c.name }));
    } else if (category === 'moon') {
      items = renderer.sunMoon.filter(s => s.type === 'moon').map(s => ({ ...s }));
    }

    if (items.length === 0) {
      setStatus('No data available yet');
      setTimeout(() => setStatus(''), 2000);
      return;
    }

    searchInput.value = '';
    searchResults.innerHTML = items.map(m => `
      <div class="search-item" data-name="${m.name}" data-type="${m.type}">
        <span class="search-icon">${m.symbol || (m.type==='star' ? '★' : '⊹')}</span>
        <span class="search-name">${m.name}</span>
        <span class="search-meta">${m.alt !== undefined ? (m.alt > 0 ? formatAlt(m.alt) : 'Below horizon') : ''}</span>
      </div>
    `).join('');

    searchResults.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        const found = items.find(i => i.name === el.dataset.name && i.type === el.dataset.type);
        if (found) selectObject(found, found.type);
        searchResults.classList.add('hidden');
      });
    });
    // Open search bar so results are visible
    searchBar.classList.remove('hidden');
    searchResults.classList.remove('hidden');
    searchInput.focus();
  }

  // ── Stardate (Metric/TNG style: YYYY.fraction) ────────────
  function computeStardate(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    const diff  = d - start;
    const oneDay = 86400000;
    const doy  = Math.floor(diff / oneDay);
    const frac = (doy / 365.25 * 1000).toFixed(0).padStart(3, '0');
    return `${d.getFullYear()}.${frac}`;
  }

  // ── Time display ───────────────────────────────────────────
  function updateTimeDisplay() {
    const now = new Date();
    if (timeDisplay)     timeDisplay.textContent     = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    if (stardateDisplay) stardateDisplay.textContent = computeStardate(now);
  }

  // ── Status bar ─────────────────────────────────────────────
  function setStatus(msg) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('hidden', !msg);
  }

  function setSidebarStatus(msg) {
    if (sidebarStatus) sidebarStatus.textContent = msg;
  }

  // ── Start ──────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// ============================================================
// app.js  –  Star Track main application controller
// ============================================================

(function () {
  'use strict';

  // ── DOM references ─────────────────────────────────────────
  const canvas        = document.getElementById('sky-canvas');
  const statusEl      = document.getElementById('status-bar');
  const searchInput   = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const infoPanel     = document.getElementById('info-panel');
  const infoPanelBody = document.getElementById('info-panel-body');
  const btnAR         = document.getElementById('btn-ar');
  const btnMap        = document.getElementById('btn-map');
  const btnSettings   = document.getElementById('btn-settings');
  const btnLocate     = document.getElementById('btn-locate');
  const settingsPanel = document.getElementById('settings-panel');
  const timeDisplay   = document.getElementById('time-display');

  // Checkboxes / sliders
  const chkLines   = document.getElementById('chk-lines');
  const chkLabels  = document.getElementById('chk-labels');
  const chkNames   = document.getElementById('chk-names');
  const chkGrid    = document.getElementById('chk-grid');
  const sliderMag  = document.getElementById('slider-mag');
  const sliderMagVal = document.getElementById('slider-mag-val');

  // ── State ──────────────────────────────────────────────────
  let lat = 52.0, lon = 5.0;   // default: Netherlands
  let locationKnown = false;
  let renderer;
  let animHandle;
  let lastComputeTime = 0;
  let orientation = { alpha: null, beta: null, gamma: null };
  let useDeviceOrientation = false;
  let compassAlpha = null; // smoothed heading

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
    startLoop();

    btnAR.addEventListener('click',       switchToAR);
    btnMap.addEventListener('click',      switchToMap);
    btnSettings.addEventListener('click', toggleSettings);
    btnLocate.addEventListener('click',   requestGeolocation);

    // Mode default
    switchToMap();
  }

  // ── Resize observer ────────────────────────────────────────
  function setupResizeObserver() {
    const ro = new ResizeObserver(() => { renderer.resize(); });
    ro.observe(canvas);
  }

  // ── Animation loop ─────────────────────────────────────────
  function startLoop() {
    function frame(ts) {
      animHandle = requestAnimationFrame(frame);
      const now = Date.now();
      if (now - lastComputeTime > 5000) { // recompute every 5 s
        computePositions(now);
        lastComputeTime = now;
      }
      if (useDeviceOrientation) {
        applyDeviceOrientation();
      }
      renderer.date = new Date();
      renderer.render();
      updateTimeDisplay();
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

    // Planets & Sun/Moon (need astronomy-engine loaded)
    if (typeof Astronomy !== 'undefined') {
      renderer.planets = getPlanets(lat, lon, date);
      renderer.sunMoon = getSunMoon(lat, lon, date);
    }
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
        locationKnown = true;
        setStatus(`Location: ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`);
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

    // Smooth compass heading
    let targetAlpha = orientation.alpha;
    if (compassAlpha === null) compassAlpha = targetAlpha;
    // Shortest-arc interpolation
    let diff = targetAlpha - compassAlpha;
    if (diff >  180) diff -= 360;
    if (diff < -180) diff += 360;
    compassAlpha = (compassAlpha + diff * 0.15 + 360) % 360;

    // When holding phone portrait up to sky:
    // beta = 90° -> looking at horizon, beta = 0° -> flat on table, beta = -90° -> looking straight up
    // altitude = -(beta - 90) ... but beta ranges -180 to 180
    // If beta > 0: phone is tilted forward (top away), altitude = 90 - beta
    // Clamped altitude
    const beta = orientation.beta ?? 45;
    const alt  = Math.max(-10, Math.min(90, 90 - beta));

    // Azimuth from compass + gamma correction for portrait tilt
    // In portrait mode az = compassAlpha (approximately, with small gamma correction)
    const gamma = orientation.gamma ?? 0;
    // Rough correction for device roll
    const az = ((compassAlpha + gamma * 0.5) % 360 + 360) % 360;

    renderer.viewAz  = az;
    renderer.viewAlt = alt;
  }

  // ── Mode switching ─────────────────────────────────────────
  function switchToMap() {
    renderer.mode = 'map';
    btnMap.classList.add('active');
    btnAR.classList.remove('active');
    useDeviceOrientation = false;
    setStatus('');
  }

  function switchToAR() {
    renderer.mode = 'ar';
    btnAR.classList.add('active');
    btnMap.classList.remove('active');

    // Try to activate device orientation
    useDeviceOrientation = true;
    requestDeviceOrientation();
    setStatus('Point your device at the sky ↑');
    setTimeout(() => {
      if (orientation.alpha === null) {
        setStatus('Sensors unavailable – drag to look around');
      } else {
        setStatus('');
      }
    }, 2000);
  }

  // ── Search ─────────────────────────────────────────────────
  function setupSearch() {
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('focus', onSearchInput);
    document.addEventListener('click', e => {
      if (!searchResults.contains(e.target) && e.target !== searchInput) {
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
      items.push({
        id: p.name, type: 'planet', icon: p.symbol,
        name: p.name, abbr: '',
        meta: p.alt > 0 ? `Alt ${formatAlt(p.alt)}` : 'Below horizon',
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
    infoPanel.classList.remove('hidden');
  }

  // ── Canvas tap / click ─────────────────────────────────────
  function setupCanvasInteraction() {
    let touchStartX, touchStartY, touchStartTime;
    let dragStartAz, dragStartAlt, dragLastX, dragLastY;
    let isDragging = false;

    canvas.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      dragStartAz  = renderer.viewAz;
      dragStartAlt = renderer.viewAlt;
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
        renderer.viewAlt = Math.max(-10, Math.min(90, renderer.viewAlt + dy * 0.3));
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
    let mouseDown = false, lastMX, lastMY;
    canvas.addEventListener('mousedown', e => {
      mouseDown = true; lastMX = e.clientX; lastMY = e.clientY;
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
        renderer.viewAlt = Math.max(-10, Math.min(90, renderer.viewAlt + dy * 0.4));
        useDeviceOrientation = false;
      }
    });
    canvas.addEventListener('mouseup', e => {
      const dx = e.clientX - lastMX, dy = e.clientY - lastMY;
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
        hitTestAt(e.clientX, e.clientY);
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

  // ── Settings panel ─────────────────────────────────────────
  function setupSettings() {
    chkLines.checked   = renderer.showConstellationLines;
    chkLabels.checked  = renderer.showConstellationLabels;
    chkNames.checked   = renderer.showStarNames;
    chkGrid.checked    = renderer.showGrid;
    sliderMag.value    = renderer.limitMag;
    sliderMagVal.textContent = renderer.limitMag.toFixed(1);

    chkLines.addEventListener('change',  () => renderer.showConstellationLines  = chkLines.checked);
    chkLabels.addEventListener('change', () => renderer.showConstellationLabels = chkLabels.checked);
    chkNames.addEventListener('change',  () => renderer.showStarNames  = chkNames.checked);
    chkGrid.addEventListener('change',   () => renderer.showGrid = chkGrid.checked);
    sliderMag.addEventListener('input', () => {
      renderer.limitMag = parseFloat(sliderMag.value);
      sliderMagVal.textContent = renderer.limitMag.toFixed(1);
    });

    settingsPanel.addEventListener('click', e => e.stopPropagation());
  }

  function toggleSettings() {
    settingsPanel.classList.toggle('hidden');
    document.addEventListener('click', hideSettings, { once: true });
  }

  function hideSettings() {
    settingsPanel.classList.add('hidden');
  }

  // ── Filter buttons (bottom bar) ────────────────────────────
  function setupFilterButtons() {
    document.getElementById('filter-planets').addEventListener('click', () => showQuickList('planets'));
    document.getElementById('filter-stars').addEventListener('click',   () => showQuickList('stars'));
    document.getElementById('filter-constellations').addEventListener('click', () => showQuickList('constellations'));
    document.getElementById('filter-moon').addEventListener('click',    () => showQuickList('moon'));
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
    searchResults.classList.remove('hidden');
    searchInput.focus();
  }

  // ── Time display ───────────────────────────────────────────
  function updateTimeDisplay() {
    const now = new Date();
    timeDisplay.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ── Status bar ─────────────────────────────────────────────
  function setStatus(msg) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('hidden', !msg);
  }

  // ── Start ──────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

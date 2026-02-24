// ============================================================
// astronomy.js  –  Coordinate transforms & planet positions
// Uses the astronomy-engine library (loaded via CDN) for
// accurate planet positions; implements RA/Dec ↔ Alt/Az math.
// ============================================================

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// ─── Julian Date ────────────────────────────────────────────
function julianDate(date = new Date()) {
  return date.valueOf() / 86400000.0 + 2440587.5;
}

// ─── Greenwich Mean Sidereal Time (degrees) ─────────────────
function gmst(date = new Date()) {
  const jd = julianDate(date);
  const T  = (jd - 2451545.0) / 36525.0;
  let   st = 280.46061837
            + 360.98564736629 * (jd - 2451545.0)
            + T * T * 0.000387933
            - T * T * T / 38710000.0;
  return ((st % 360) + 360) % 360;
}

// ─── Local Sidereal Time (degrees) ──────────────────────────
function lst(longitude, date = new Date()) {
  return ((gmst(date) + longitude) % 360 + 360) % 360;
}

// ─── RA/Dec → Alt/Az ────────────────────────────────────────
// ra, dec, lat, lon all in degrees; returns {alt, az} in degrees
function raDecToAltAz(ra, dec, lat, lon, date = new Date()) {
  const localST = lst(lon, date);
  const ha = ((localST - ra) % 360 + 360) % 360; // hour angle (degrees)

  const haR  = ha  * DEG;
  const decR = dec * DEG;
  const latR = lat * DEG;

  const sinAlt = Math.sin(decR) * Math.sin(latR)
               + Math.cos(decR) * Math.cos(latR) * Math.cos(haR);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * RAD;

  const cosAz = (Math.sin(decR) - Math.sin(latR) * Math.sin(alt * DEG))
              / (Math.cos(latR) * Math.cos(alt * DEG));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD;
  if (Math.sin(haR) > 0) az = 360 - az;

  return { alt, az };
}

// ─── Alt/Az → RA/Dec (inverse) ──────────────────────────────
function altAzToRaDec(alt, az, lat, lon, date = new Date()) {
  const altR = alt * DEG;
  const azR  = az  * DEG;
  const latR = lat * DEG;

  const sinDec = Math.sin(altR) * Math.sin(latR)
               + Math.cos(altR) * Math.cos(latR) * Math.cos(azR);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * RAD;

  const cosHA = (Math.sin(altR) - Math.sin(latR) * Math.sin(dec * DEG))
              / (Math.cos(latR) * Math.cos(dec * DEG));
  let ha = Math.acos(Math.max(-1, Math.min(1, cosHA))) * RAD;
  if (Math.sin(azR) > 0) ha = 360 - ha;

  const localST = lst(lon, date);
  const ra = ((localST - ha) % 360 + 360) % 360;
  return { ra, dec };
}

// ─── Planet Positions via astronomy-engine ──────────────────
// Returns array of { name, symbol, ra, dec, alt, az, mag, info }
function getPlanets(lat, lon, date = new Date()) {
  const bodies = [
    { id: 'Mercury', name: 'Mercury', symbol: '☿', color: '#b5b5b5' },
    { id: 'Venus',   name: 'Venus',   symbol: '♀', color: '#f5deb3' },
    { id: 'Mars',    name: 'Mars',    symbol: '♂', color: '#e07040' },
    { id: 'Jupiter', name: 'Jupiter', symbol: '♃', color: '#c8a87a' },
    { id: 'Saturn',  name: 'Saturn',  symbol: '♄', color: '#e8d5a0' },
    { id: 'Uranus',  name: 'Uranus',  symbol: '⛢', color: '#7fffd4' },
    { id: 'Neptune', name: 'Neptune', symbol: '♆', color: '#4169e1' },
  ];

  const observer  = new Astronomy.Observer(lat, lon, 0);
  const astroDate = new Astronomy.AstroTime(date);

  const planets = [];
  for (const b of bodies) {
    try {
      const eq    = Astronomy.Equator(b.id, astroDate, observer, true, true);
      const hor   = Astronomy.Horizon(astroDate, observer, eq.ra, eq.dec, 'normal');
      let   mag   = null;
      try { mag = Astronomy.Illumination(b.id, astroDate).mag; } catch(_) {}
      planets.push({
        name:   b.name,
        symbol: b.symbol,
        color:  b.color,
        ra:     eq.ra * 15,   // hours → degrees
        dec:    eq.dec,
        alt:    hor.altitude,
        az:     hor.azimuth,
        mag:    mag,
        type:   'planet',
      });
    } catch (e) {
      console.warn('Planet error:', b.name, e);
    }
  }
  return planets;
}

// ─── Sun & Moon ─────────────────────────────────────────────
function getSunMoon(lat, lon, date = new Date()) {
  const observer  = new Astronomy.Observer(lat, lon, 0);
  const astroDate = new Astronomy.AstroTime(date);
  const results   = [];

  try {
    const sunEq  = Astronomy.Equator('Sun', astroDate, observer, true, true);
    const sunHor = Astronomy.Horizon(astroDate, observer, sunEq.ra, sunEq.dec, 'normal');
    results.push({
      name: 'Sun', symbol: '☀', color: '#FFD700',
      ra: sunEq.ra * 15, dec: sunEq.dec,
      alt: sunHor.altitude, az: sunHor.azimuth,
      type: 'sun',
    });
  } catch (e) { console.warn('Sun error', e); }

  try {
    const moonEq   = Astronomy.Equator('Moon', astroDate, observer, true, true);
    const moonHor  = Astronomy.Horizon(astroDate, observer, moonEq.ra, moonEq.dec, 'normal');
    const moonPhase = Astronomy.MoonPhase(astroDate);
    results.push({
      name: 'Moon', symbol: '☽', color: '#e8e8d0',
      ra: moonEq.ra * 15, dec: moonEq.dec,
      alt: moonHor.altitude, az: moonHor.azimuth,
      phase: moonPhase,
      type: 'moon',
    });
  } catch (e) { console.warn('Moon error', e); }

  return results;
}

// ─── Rise/Set times ─────────────────────────────────────────
function getRiseSet(bodyName, lat, lon, date = new Date()) {
  const observer  = new Astronomy.Observer(lat, lon, 0);
  const startTime = new Astronomy.AstroTime(date);
  try {
    const rise = Astronomy.SearchRiseSet(bodyName, observer, +1, startTime, 1);
    const set  = Astronomy.SearchRiseSet(bodyName, observer, -1, startTime, 1);
    const fmt  = (t) => t ? t.date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--';
    return { rise: fmt(rise), set: fmt(set) };
  } catch (e) {
    return { rise: '--', set: '--' };
  }
}

// ─── Moon phase description ──────────────────────────────────
function moonPhaseName(angle) {
  if (angle < 22.5 || angle >= 337.5) return 'New Moon';
  if (angle < 67.5)  return 'Waxing Crescent';
  if (angle < 112.5) return 'First Quarter';
  if (angle < 157.5) return 'Waxing Gibbous';
  if (angle < 202.5) return 'Full Moon';
  if (angle < 247.5) return 'Waning Gibbous';
  if (angle < 292.5) return 'Last Quarter';
  return 'Waning Crescent';
}

// ─── Spectral type → color ───────────────────────────────────
function spectralColor(spec = '') {
  const t = spec.charAt(0).toUpperCase();
  const colors = {
    O: '#9bb0ff', B: '#aabfff', A: '#cad7ff',
    F: '#f8f7ff', G: '#fff4ea', K: '#ffd2a1', M: '#ffad60',
  };
  return colors[t] || '#ffffff';
}

// ─── Format coordinates for display ─────────────────────────
function formatAlt(deg) {
  const sign = deg < 0 ? '-' : '+';
  const abs  = Math.abs(deg);
  const d    = Math.floor(abs);
  const m    = Math.floor((abs - d) * 60);
  return `${sign}${d}° ${m}'`;
}

function formatAz(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                'S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return `${dirs[idx]} (${Math.round(deg)}°)`;
}

function formatRA(deg) {
  const h =  Math.floor(deg / 15);
  const m =  Math.floor((deg / 15 - h) * 60);
  const s =  Math.round(((deg / 15 - h) * 60 - m) * 60);
  return `${h}h ${m}m ${s}s`;
}

function formatDec(deg) {
  const sign = deg < 0 ? '-' : '+';
  const abs  = Math.abs(deg);
  const d    = Math.floor(abs);
  const m    = Math.floor((abs - d) * 60);
  return `${sign}${d}° ${m}'`;
}

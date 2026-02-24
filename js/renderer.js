// ============================================================
// renderer.js  –  Canvas-based sky renderer
// Two render modes: 'map' (full hemisphere) and 'ar' (look-through)
// ============================================================

class SkyRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    // Render state
    this.mode        = 'map';   // 'map' | 'ar'
    this.lat         = 0;
    this.lon         = 0;
    this.date        = new Date();

    // AR view centre (azimuth / altitude in degrees)
    this.viewAz  = 180;   // S by default
    this.viewAlt = 45;

    // Map mode rotation (azimuth at top == 0 → North)
    this.mapRotation = 0; // degrees, N at top

    // Data arrays (set by app.js after computing)
    this.stars       = [];  // { ra,dec,mag,name,spectral,con }
    this.planets     = [];
    this.sunMoon     = [];
    this.constellations = [];

    // Selection
    this.selected    = null;
    this.highlightTarget = null; // {az,alt} to draw a pointer ring

    // Settings
    this.showConstellationLines  = true;
    this.showConstellationLabels = true;
    this.showStarNames  = false;
    this.showGrid       = false;
    this.limitMag       = 5.5;  // faintest magnitude to show
    this.fieldOfView    = 90;   // degrees FOV for AR mode (half-angle = 45)
  }

  // ── Resize ────────────────────────────────────────────────
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = this.canvas.clientWidth  * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    // Reset transform first so scale does not compound
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Main render entry ─────────────────────────────────────
  render() {
    const { canvas, ctx } = this;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    if (this.mode === 'map') {
      this._renderMap(W, H);
    } else {
      this._renderAR(W, H);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FULL SKY MAP (stereographic projection, N at top)
  // ═══════════════════════════════════════════════════════════
  _renderMap(W, H) {
    const ctx  = this.ctx;
    const cx   = W / 2;
    const cy   = H / 2;
    const R    = Math.min(W, H) / 2 - 16;  // planisphere radius

    // ── Background gradient ──────────────────────────────────
    const isDaytime = this._isSunUp();
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    if (isDaytime) {
      bg.addColorStop(0,   '#2d5fad');
      bg.addColorStop(0.7, '#1a3a7a');
      bg.addColorStop(1,   '#0a1a3a');
    } else {
      bg.addColorStop(0,   '#0d1b2a');
      bg.addColorStop(0.6, '#070e1a');
      bg.addColorStop(1,   '#020408');
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.restore();

    // ── Project alt/az → x,y (linear from zenith) ───────────
    const project = (alt, az) => {
      const dist = (90 - alt) / 90 * R;
      const angle = (az - this.mapRotation) * DEG;
      return {
        x: cx + dist * Math.sin(angle),
        y: cy - dist * Math.cos(angle),
      };
    };

    // ── Alt/Az grid ──────────────────────────────────────────
    if (this.showGrid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = 0.5;
      // altitude circles
      for (let a = 0; a < 90; a += 30) {
        const r  = (90 - a) / 90 * R;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      // azimuth lines
      for (let a = 0; a < 360; a += 30) {
        const { x, y } = project(0, a);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Horizon circle ───────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.clip(); // clip everything to horizon circle

    // ── Milky Way hint ───────────────────────────────────────
    this._drawMilkyWay(ctx, cx, cy, R, project);

    // ── Constellation lines ──────────────────────────────────
    if (this.showConstellationLines) {
      this._drawConstellationLines(ctx, project, false);
    }

    // ── Stars ────────────────────────────────────────────────
    for (const s of this.stars) {
      if (s.alt < -2)         continue;
      if (s.mag > this.limitMag) continue;
      const { x, y } = project(s.alt, s.az);
      this._drawStar(ctx, x, y, s, false);
    }

    // ── Sun / Moon / Planets ─────────────────────────────────
    for (const obj of [...this.sunMoon, ...this.planets]) {
      if (obj.alt < -2) continue;
      const { x, y } = project(obj.alt, obj.az);
      this._drawBodyIcon(ctx, x, y, obj, false, project);
    }

    // ── Highlight ring for selected / target ─────────────────
    if (this.highlightTarget) {
      const { x, y } = project(this.highlightTarget.alt, this.highlightTarget.az);
      this._drawTargetRing(ctx, x, y);
    }

    ctx.restore(); // end clip

    // ── Compass labels ───────────────────────────────────────
    this._drawCompassLabels(ctx, cx, cy, R);

    // ── Constellation labels (outside clip for legibility) ───
    if (this.showConstellationLabels) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      this._drawConstellationLabels(ctx, project);
      ctx.restore();
    }

    // ── Star name labels ─────────────────────────────────────
    if (this.showStarNames) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      for (const s of this.stars) {
        if (s.alt < 0 || s.mag > 2.5) continue;
        const { x, y } = project(s.alt, s.az);
        this._drawLabel(ctx, x + 7, y - 4, s.name, 'rgba(200,220,255,0.8)', 11);
      }
      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // AR LOOK-THROUGH  (gnomonic projection)
  // ═══════════════════════════════════════════════════════════
  _renderAR(W, H) {
    const ctx = this.ctx;

    // ── Background ───────────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    const isDaytime = this._isSunUp();
    if (isDaytime) {
      bg.addColorStop(0, '#1a3a8a');
      bg.addColorStop(1, '#0d1f4a');
    } else {
      bg.addColorStop(0, '#050d18');
      bg.addColorStop(1, '#010408');
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Gnomonic projection  ─────────────────────────────────
    // FOV half-angle in degrees
    const fovH = this.fieldOfView / 2;
    const scale = (Math.min(W, H) / 2) / Math.tan(fovH * DEG);

    const project = (alt, az, allowBehind = false) => {
      // Convert (alt,az) to unit vector in horizontal coords
      // Then project onto plane tangent at (viewAlt, viewAz)
      const altR  = alt * DEG;
      const azR   = az  * DEG;
      const vAltR = this.viewAlt * DEG;
      const vAzR  = this.viewAz  * DEG;

      // Object vector
      const ox =  Math.cos(altR) * Math.sin(azR);
      const oy =  Math.cos(altR) * Math.cos(azR);
      const oz =  Math.sin(altR);

      // View centre vector
      const vx =  Math.cos(vAltR) * Math.sin(vAzR);
      const vy =  Math.cos(vAltR) * Math.cos(vAzR);
      const vz =  Math.sin(vAltR);

      // dot product
      const dot = ox*vx + oy*vy + oz*vz;
      if (!allowBehind && dot <= 0) return null; // behind the projection plane

      // Tangent plane axes
      // East axis: perpendicular to view in horizontal plane
      const ex = -Math.cos(vAzR);
      const ey =  Math.sin(vAzR);
      const ez =  0;

      // Up axis: perpendicular to both view and east
      const nx = vz*ey - vy*ez;
      const ny = vx*ez - vz*ex;
      const nz = vy*ex - vx*ey;

      // If behind, we still want a direction, so we can just use the projection
      // but we might need to flip it or just use the raw px/py for direction
      const d = dot === 0 ? 0.0001 : dot;
      // For direction, we don't want to flip the sign if it's behind, 
      // otherwise the angle will be 180 degrees off.
      // Wait, if dot < 0, dividing by d (negative) flips the sign, which is correct for direction!
      // But if we want to draw it on screen, we might want to use Math.abs(d).
      // Actually, for direction, we should just use d.
      const px = (ox*ex + oy*ey + oz*ez) / (allowBehind ? Math.abs(d) : d) * scale;
      const py = (ox*nx + oy*ny + oz*nz) / (allowBehind ? Math.abs(d) : d) * scale;

      // Negate px: East tangent vector points West in the original formula → flip.
      // Use H/2 + py (not -py): Up tangent sign is also inverted.
      return { x: W/2 - px, y: H/2 + py, behind: dot <= 0 };
    };

    // ── Alt/Az grid ──────────────────────────────────────────
    if (this.showGrid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth   = 0.7;
      for (let a = -80; a <= 90; a += 15) {
        ctx.beginPath();
        let first = true;
        for (let az = 0; az <= 360; az += 2) {
          const p = project(a, az);
          if (!p || p.x < -50 || p.x > W+50 || p.y < -50 || p.y > H+50) { first = true; continue; }
          if (first) { ctx.moveTo(p.x, p.y); first = false; }
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      for (let az = 0; az < 360; az += 15) {
        ctx.beginPath();
        let first = true;
        for (let a = -10; a <= 90; a += 2) {
          const p = project(a, az);
          if (!p || p.x < -50 || p.x > W+50 || p.y < -50 || p.y > H+50) { first = true; continue; }
          if (first) { ctx.moveTo(p.x, p.y); first = false; }
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Horizon line ─────────────────────────────────────────
    {
      ctx.save();
      ctx.strokeStyle = 'rgba(80,150,255,0.35)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      let first = true;
      for (let az = 0; az <= 360; az += 1) {
        const p = project(0, az);
        if (!p || p.x < -100 || p.x > W+100) { first = true; continue; }
        if (first) { ctx.moveTo(p.x, p.y); first = false; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ── Constellation lines ──────────────────────────────────
    if (this.showConstellationLines) {
      this._drawConstellationLines(ctx, project, true);
    }

    // ── Stars ────────────────────────────────────────────────
    for (const s of this.stars) {
      if (s.alt < -5)          continue;
      if (s.mag > this.limitMag + 1) continue;
      const p = project(s.alt, s.az);
      if (!p || p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue;
      this._drawStar(ctx, p.x, p.y, s, true);
    }

    // ── Sun / Moon / Planets ─────────────────────────────────
    for (const obj of [...this.sunMoon, ...this.planets]) {
      const p = project(obj.alt, obj.az);
      if (!p || p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue;
      this._drawBodyIcon(ctx, p.x, p.y, obj, true, project);
    }

    // ── Star names in AR ─────────────────────────────────────
    if (this.showStarNames) {
      for (const s of this.stars) {
        if (s.alt < 0 || s.mag > 2.5) continue;
        const p = project(s.alt, s.az);
        if (!p || p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue;
        this._drawLabel(ctx, p.x + 8, p.y - 4, s.name, 'rgba(200,220,255,0.8)', 11);
      }
    }

    // ── Constellation labels ─────────────────────────────────
    if (this.showConstellationLabels) {
      this._drawConstellationLabels(ctx, project);
    }

    // ── Highlight ring ───────────────────────────────────────
    if (this.highlightTarget) {
      const p = project(this.highlightTarget.alt, this.highlightTarget.az);
      if (p) {
        this._drawTargetRing(ctx, p.x, p.y);
        // Draw off-screen arrow if target outside view
        if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
          this._drawOffscreenArrow(ctx, W, H, p.x, p.y);
        }
      }
    }

    // ── AR crosshair ─────────────────────────────────────────
    this._drawCrosshair(ctx, W / 2, H / 2);

    // ── HUD: current pointing info ───────────────────────────
    this._drawHUD(ctx, W, H);
  }

  // ═══════════════════════════════════════════════════════════
  // DRAWING HELPERS
  // ═══════════════════════════════════════════════════════════

  _drawMilkyWay(ctx, cx, cy, R, project) {
    // Simplified Milky Way band – just a soft glow along the galactic plane
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.translate(cx, cy);
    const band = ctx.createLinearGradient(-R, 0, R, 0);
    band.addColorStop(0,   'transparent');
    band.addColorStop(0.3, 'rgba(200,220,255,0.3)');
    band.addColorStop(0.5, 'rgba(200,220,255,0.5)');
    band.addColorStop(0.7, 'rgba(200,220,255,0.3)');
    band.addColorStop(1,   'transparent');
    ctx.fillStyle = band;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
  }

  _drawConstellationLines(ctx, project, ar) {
    ctx.save();
    ctx.strokeStyle = 'rgba(100,160,255,0.30)';
    ctx.lineWidth   = 0.8;
    for (const con of this.constellations) {
      if (!con.computedLines) continue;
      for (const { a1, a2 } of con.computedLines) {
        if (ar) {
          if (a1.alt < -10 && a2.alt < -10) continue;
        } else {
          if (a1.alt < 0 && a2.alt < 0) continue;
        }
        const p1 = project(a1.alt, a1.az);
        const p2 = project(a2.alt, a2.az);
        if (!p1 || !p2) continue;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawConstellationLabels(ctx, project) {
    ctx.save();
    ctx.font      = '10px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(100,160,255,0.60)';
    ctx.textAlign = 'center';
    for (const con of this.constellations) {
      if (!con.computedLines || con.computedLines.length === 0) continue;
      // Use centroid of all line endpoints
      let sumAlt = 0, sumAzX = 0, sumAzY = 0, n = 0;
      for (const { a1, a2 } of con.computedLines) {
        sumAlt += a1.alt + a2.alt;
        sumAzX += Math.cos(a1.az * DEG) + Math.cos(a2.az * DEG);
        sumAzY += Math.sin(a1.az * DEG) + Math.sin(a2.az * DEG);
        n += 2;
      }
      const alt = sumAlt / n;
      const az = Math.atan2(sumAzY, sumAzX) * RAD;
      if (alt < 0) continue;
      const p = project(alt, az);
      if (!p) continue;
      ctx.fillText(con.name, p.x, p.y);
    }
    ctx.restore();
  }

  _drawStar(ctx, x, y, star, arMode) {
    const size = Math.max(0.5, (6 - star.mag) * (arMode ? 1.2 : 0.9));
    const color = spectralColor(star.spectral);

    // Glow for bright stars
    if (star.mag < 2.0) {
      ctx.save();
      ctx.translate(x, y);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 3.5);
      glow.addColorStop(0,   color.replace(')', ',0.5)').replace('rgb', 'rgba'));
      glow.addColorStop(1,   'transparent');
      ctx.beginPath();
      ctx.arc(0, 0, size * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      ctx.restore();
    }

    // Highlight selected
    if (this.selected && this.selected.name === star.name) {
      ctx.beginPath();
      ctx.arc(x, y, size + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  _drawBodyIcon(ctx, x, y, obj, arMode, project) {
    const r = obj.type === 'sun'  ? (arMode ? 22 : 14)
            : obj.type === 'moon' ? (arMode ? 18 : 11)
            : (arMode ? 10 : 7);

    if (this.selected && this.selected.name === obj.name) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    if (obj.type === 'sun') {
      // Sun glow
      ctx.save();
      ctx.translate(x, y);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.5);
      glow.addColorStop(0,   'rgba(255,220,50,0.8)');
      glow.addColorStop(0.4, 'rgba(255,150,0,0.4)');
      glow.addColorStop(1,   'transparent');
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#FFE44D';
      ctx.fill();
    } else if (obj.type === 'moon') {
      let sunAngle = 0;
      const sun = this.sunMoon.find(b => b.type === 'sun');
      if (sun && project) {
        // To get the correct angle on screen, we project both moon and sun
        // without perspective division (orthographic) to avoid behind-camera issues.
        // But since we don't have orthographic project, we can just project a point
        // slightly towards the sun from the moon.
        const dAz = (((sun.az - obj.az + 540) % 360) - 180);
        const dAlt = sun.alt - obj.alt;
        // Point slightly towards sun
        const pDir = project(obj.alt + dAlt * 0.01, obj.az + dAz * 0.01, true);
        if (pDir) {
          sunAngle = Math.atan2(pDir.y - y, pDir.x - x);
        }
      }
      this._drawMoonPhase(ctx, x, y, r, obj.phase ?? 0, sunAngle);
    } else {
      // Planet: colored circle + symbol
      ctx.save();
      ctx.translate(x, y);
      const grd = ctx.createRadialGradient(-r*0.3, -r*0.3, 0, 0, 0, r);
      grd.addColorStop(0, obj.color);
      grd.addColorStop(1, this._darken(obj.color));
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.restore();
    }

    // Name label
    ctx.save();
    ctx.fillStyle = obj.color || '#ffffff';
    ctx.font      = `${arMode ? 11 : 9}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(obj.name, x + r + 3, y + 4);
    ctx.restore();
  }

  // ── Moon phase (crescent / gibbous / full) ────────────────
  // phase: 0=New, 90=First Quarter, 180=Full, 270=Last Quarter
  _drawMoonPhase(ctx, x, y, r, phase, sunAngle = 0) {
    const PA  = ((phase % 360) + 360) % 360;
    const lit  = 'rgba(212,212,192,0.95)';
    const dark = 'rgba(18,18,28,0.95)';

    ctx.save();
    ctx.translate(x, y);
    // Rotate so the illuminated side points towards the sun
    // The default drawing assumes the sun is to the right (0 radians)
    // We rotate the canvas by sunAngle
    ctx.rotate(sunAngle);

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();

    if (PA < 180) {
      // Waxing: illuminated on the RIGHT side
      // Draw right half light
      ctx.beginPath();
      ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(0, -r);
      ctx.fillStyle = lit;
      ctx.fill();
      // Draw left half dark
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.PI / 2, -Math.PI / 2);
      ctx.lineTo(0, r);
      ctx.fillStyle = dark;
      ctx.fill();
      // Terminator ellipse
      const tw = r * Math.abs(Math.cos(PA * DEG));
      if (tw > 0.5) {
        ctx.beginPath();
        ctx.ellipse(0, 0, tw, r, 0, 0, Math.PI * 2);
        ctx.fillStyle = PA < 90 ? dark : lit; // crescent → dark covers right nub; gibbous → light fills
        ctx.fill();
      }
    } else {
      // Waning: illuminated on the LEFT side
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.PI / 2, -Math.PI / 2);
      ctx.lineTo(0, r);
      ctx.fillStyle = lit;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(0, -r);
      ctx.fillStyle = dark;
      ctx.fill();
      const tw = r * Math.abs(Math.cos(PA * DEG));
      if (tw > 0.5) {
        ctx.beginPath();
        ctx.ellipse(0, 0, tw, r, 0, 0, Math.PI * 2);
        ctx.fillStyle = PA < 270 ? lit : dark; // gibbous → light fills waning right; crescent → dark
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _drawCrosshair(ctx, cx, cy) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth   = 1;
    const d = 20;
    // vertical
    ctx.beginPath(); ctx.moveTo(cx, cy-d); ctx.lineTo(cx, cy-6);
    ctx.moveTo(cx, cy+6); ctx.lineTo(cx, cy+d);
    // horizontal
    ctx.moveTo(cx-d, cy); ctx.lineTo(cx-6, cy);
    ctx.moveTo(cx+6, cy); ctx.lineTo(cx+d, cy);
    ctx.stroke();
    // centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();
    ctx.restore();
  }

  _drawCompassLabels(ctx, cx, cy, R) {
    const dirs = [
      { label: 'N',  az: 0   },
      { label: 'NE', az: 45  },
      { label: 'E',  az: 90  },
      { label: 'SE', az: 135 },
      { label: 'S',  az: 180 },
      { label: 'SW', az: 225 },
      { label: 'W',  az: 270 },
      { label: 'NW', az: 315 },
    ];
    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    for (const d of dirs) {
      const angle  = (d.az - this.mapRotation) * DEG;
      const isCard = d.label.length === 1;
      const rr     = R + (isCard ? 12 : 10);
      const x      = cx + rr * Math.sin(angle);
      const y      = cy - rr * Math.cos(angle);
      ctx.font      = isCard ? 'bold 13px sans-serif' : '10px sans-serif';
      ctx.fillStyle = isCard ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)';
      ctx.fillText(d.label, x, y);
    }
    ctx.restore();
  }

  _drawTargetRing(ctx, x, y) {
    ctx.save();
    const t = Date.now() / 600;
    const pulse = 12 + Math.sin(t) * 4;
    ctx.beginPath();
    ctx.arc(x, y, pulse, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth   = 2;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }

  _drawOffscreenArrow(ctx, W, H, tx, ty) {
    const cx = W / 2, cy = H / 2;
    const angle = Math.atan2(ty - cy, tx - cx);
    const margin = 30;
    const ax = cx + Math.cos(angle) * (Math.min(W, H) / 2 - margin);
    const ay = cy + Math.sin(angle) * (Math.min(W, H) / 2 - margin);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(14, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fillStyle = '#ffd700';
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.restore();
  }

  _drawHUD(ctx, W, H) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(8, H - 44, 180, 36);
    ctx.fillStyle = 'rgba(150,200,255,0.9)';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Az: ${formatAz(this.viewAz)}`, 14, H - 38);
    ctx.fillText(`Alt: ${formatAlt(this.viewAlt)}`, 14, H - 22);
    ctx.restore();
  }

  _drawLabel(ctx, x, y, text, color, size) {
    ctx.save();
    ctx.font      = `${size}px "Segoe UI", sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  _isSunUp() {
    for (const obj of this.sunMoon) {
      if (obj.type === 'sun' && obj.alt > -6) return true;
    }
    return false;
  }

  _darken(hex) {
    // Simple darken by 40%
    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    if (isNaN(r)) return '#111';
    r = Math.floor(r * 0.6); g = Math.floor(g * 0.6); b = Math.floor(b * 0.6);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  }

  // ── Hit testing (for click/tap selection) ─────────────────
  hitTest(clientX, clientY, W, H) {
    const project = this._getProjectFn(W, H);
    let best = null, bestDist = 28; // max tap radius in CSS px

    const allObjects = [...this.stars, ...this.sunMoon, ...this.planets];
    for (const obj of allObjects) {
      const alt = obj.alt ?? 0, az = obj.az ?? 0;
      if (alt < (this.mode === 'ar' ? -5 : 0)) continue;
      const p = project(alt, az);
      if (!p) continue;
      const dx = p.x - clientX, dy = p.y - clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      // Bright objects and planets get a larger tap target
      const tapR = obj.type === 'sun'  ? 26
                 : obj.type === 'moon' ? 22
                 : obj.type === 'planet' ? 16
                 : Math.max(8, 6 - (obj.mag ?? 3));
      if (dist < tapR && dist < bestDist) {
        bestDist = dist;
        best = obj;
      }
    }
    return best;
  }

  _getProjectFn(W, H) {
    if (this.mode === 'map') {
      const cx = W/2, cy = H/2, R = Math.min(W,H)/2 - 16;
      return (alt, az) => {
        const dist  = (90 - alt) / 90 * R;
        const angle = (az - this.mapRotation) * DEG;
        return { x: cx + dist * Math.sin(angle), y: cy - dist * Math.cos(angle) };
      };
    } else {
      const fovH  = this.fieldOfView / 2;
      const scale = (Math.min(W,H)/2) / Math.tan(fovH * DEG);
      return (alt, az) => {
        const altR = alt*DEG, azR = az*DEG;
        const vAltR = this.viewAlt*DEG, vAzR = this.viewAz*DEG;
        const ox = Math.cos(altR)*Math.sin(azR), oy = Math.cos(altR)*Math.cos(azR), oz = Math.sin(altR);
        const vx = Math.cos(vAltR)*Math.sin(vAzR), vy = Math.cos(vAltR)*Math.cos(vAzR), vz = Math.sin(vAltR);
        const dot = ox*vx + oy*vy + oz*vz;
        if (dot <= 0) return null;
        const ex = -Math.cos(vAzR), ey = Math.sin(vAzR);
        const nx = vz*ey, ny = -vz*ex, nz = vy*ex - vx*ey;
        const px = (ox*ex + oy*ey) / dot * scale;
        const py = (ox*nx + oy*ny + oz*nz) / dot * scale;
        return { x: W/2 - px, y: H/2 + py }; // signs match _renderAR fix
      };
    }
  }
}

/**
 * electricity-pie-card  v1.4
 * Pie chart for electricity consumption per 8h period.
 * Fetches history directly via the HA History API — no ApexCharts.
 *
 * Configuration:
 *   type: custom:electricity-pie-card
 *   entity: sensor.dsmr_reading_electricity_delivered_1
 *   title: Consumption today      # optional
 *   max_days_back: 30              # optional, default 30 (ignored if offset is set)
 *                                  # NOTE: limited by HA's recorder purge_keep_days (default 10 days)
 *   offset: 0                      # optional: 0=today, -1=yesterday, -2=day before yesterday, etc.
 *                                  # If offset is set, the date picker is NOT shown (static card)
 *   colors:                        # optional
 *     - "#5B8AF5"
 *     - "#F5A623"
 *     - "#7ED321"
 *
 * Changes in v1.1:
 *   - Fix: Timezones — now uses local time in API calls instead of UTC (toISOString)
 *   - Fix: Warning shown when history is missing due to recorder purge_keep_days
 *   - Fix: Live update of the "today" card when the sensor value changes
 *   - Fix: Single-slice pie now renders correctly as a full ring instead of a broken path
 */

class ElectricityPieCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass         = null;
    this._config       = null;
    this._selectedDate = null;   // null = today
    this._cache        = {};     // "YYYY-MM-DD" -> { values, purged }
    this._loading      = false;
    this._initialized  = false;
    this._static       = false;
    this._lastState    = null;   // for live updates
    this._reloadDebounce = null; // debounce timer for the live-update reload
  }

  disconnectedCallback() {
    if (this._reloadDebounce) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  setConfig(config) {
    if (!config.entity) throw new Error("entity is required");
    this._config = {
      entity:        config.entity,
      title:         config.title || "Electricity consumption",
      max_days_back: config.max_days_back ?? 30,
      colors:        config.colors || ["#5B8AF5", "#F5A623", "#7ED321"],
      offset:        config.offset !== undefined ? parseInt(config.offset, 10) : null,
    };
    if (this._config.offset !== null) {
      const candidate = this._offsetDate(this._localDateStr(), this._config.offset);
      this._selectedDate = candidate >= this._localDateStr() ? null : candidate;
      this._static = true;
    } else {
      this._static = false;
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._initialized) {
      this._initialized = true;
      this._loadAndRender();
      return;
    }

    // Live update: if we're showing "today" and the sensor value has changed → reload.
    // The comparison is just a string equality check — microsecond-fast, no performance impact.
    const isToday = !this._selectedDate || this._selectedDate === this._localDateStr();
    if (isToday && !this._loading) {
      const newState = hass.states[this._config.entity]?.state;
      if (newState !== undefined && newState !== this._lastState) {
        this._lastState = newState;
        delete this._cache[this._localDateStr()]; // invalidate today's cache
        // Debounce: a sensor that updates every few seconds would otherwise
        // trigger a fresh history/period/ fetch on every single tick.
        if (this._reloadDebounce) clearTimeout(this._reloadDebounce);
        this._reloadDebounce = setTimeout(() => {
          this._reloadDebounce = null;
          this._loadAndRender();
        }, 2000);
      }
    }
  }

  // ─── Date helpers (local time, never UTC) ─────────────────────────────────

  /** Today's date in local time as "YYYY-MM-DD" */
  _localDateStr(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /**
   * Formats a Date object as a local ISO string WITHOUT "Z".
   * HA interprets strings without Z as local time, which is what we want.
   * Example: "2026-05-14T00:00:00"
   */
  _localISO(date) {
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
      `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
    );
  }

  /** Resolves the language to format dates with — the HA-configured language, falling back to the browser default. */
  _locale() {
    return this._hass?.locale?.language || this._hass?.language || undefined;
  }

  _displayDate(dateStr) {
    if (!dateStr || dateStr === this._localDateStr()) return "Today";
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (dateStr === this._localDateStr(yesterday)) return "Yesterday";
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString(this._locale(), { weekday: "short", month: "short", day: "numeric" });
  }

  _offsetDate(dateStr, days) {
    const d = new Date((dateStr || this._localDateStr()) + "T12:00:00");
    d.setDate(d.getDate() + days);
    return this._localDateStr(d);
  }

  _canGoForward() {
    return this._selectedDate && this._selectedDate < this._localDateStr();
  }

  _canGoBack() {
    if (!this._selectedDate) return true;
    const minDate = this._offsetDate(this._localDateStr(), -this._config.max_days_back);
    return this._selectedDate > minDate;
  }

  // ─── History API ───────────────────────────────────────────────────────────

  async _fetchPeriodValues(dateStr) {
    if (this._cache[dateStr]) return this._cache[dateStr];

    const entity = this._config.entity;

    // Local time without Z — HA interprets this correctly regardless of daylight saving
    const dayStart  = new Date(dateStr + "T00:00:00");
    const dayEnd    = new Date(dateStr + "T23:59:59");
    const fetchFrom = new Date(dayStart.getTime() - 60 * 60 * 1000); // 1h margin

    const startISO = this._localISO(fetchFrom);
    const endISO   = this._localISO(dayEnd);

    const path = `history/period/${startISO}?filter_entity_id=${entity}&end_time=${endISO}&minimal_response=true&no_attributes=true`;
    const resp  = await this._hass.callApi("GET", path);
    const history = resp?.[0] ?? [];

    // Empty response → likely purged by recorder purge_keep_days
    if (history.length < 2) {
      return { values: [0, 0, 0], purged: true };
    }

    const points = history
      .map(s => ({
        t: s.lu ? s.lu * 1000 : new Date(s.last_changed).getTime(),
        v: parseFloat(s.state),
      }))
      .filter(p => !isNaN(p.v))
      .sort((a, b) => a.t - b.t);

    if (points.length < 2) return { values: [0, 0, 0], purged: true };

    const periods = [
      { start: new Date(dateStr + "T00:00:00").getTime(), end: new Date(dateStr + "T08:00:00").getTime() },
      { start: new Date(dateStr + "T08:00:00").getTime(), end: new Date(dateStr + "T16:00:00").getTime() },
      { start: new Date(dateStr + "T16:00:00").getTime(), end: new Date(dateStr + "T23:59:59").getTime() },
    ];

    const getValueAt = (t) => {
      let best = null;
      for (const p of points) {
        if (p.t <= t) best = p;
        else break;
      }
      return best?.v ?? null;
    };

    const values = periods.map(period => {
      const vStart = getValueAt(period.start);
      const vEnd   = getValueAt(period.end);
      if (vStart === null || vEnd === null) return 0;
      return Math.max(0, parseFloat((vEnd - vStart).toFixed(3)));
    });

    const result = { values, purged: false };
    // Don't cache today — the value keeps changing
    if (dateStr !== this._localDateStr()) {
      this._cache[dateStr] = result;
    }
    return result;
  }

  // ─── Load + render ─────────────────────────────────────────────────────────

  async _loadAndRender() {
    if (!this._hass || !this._config) return;
    this._loading = true;
    this._render();

    const dateStr = this._selectedDate || this._localDateStr();
    try {
      const result = await this._fetchPeriodValues(dateStr);
      this._loading = false;
      this._render(result.values, false, result.purged);
    } catch (e) {
      console.error("electricity-pie-card: error fetching history", e);
      this._loading = false;
      this._render([0, 0, 0], true, false);
    }
  }

  // ─── Escaping helpers ───────────────────────────────────────────────────────

  _esc(str) {
    if (str === undefined || str === null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Only allow values that actually look like a CSS color through to a style/SVG attribute. */
  _safeColor(color, fallback = "#888") {
    const c = String(color ?? "").trim();
    if (/^(#[0-9a-fA-F]{3,8}|rgba?\([^"'<>;]*\)|hsla?\([^"'<>;]*\)|var\(--[\w-]+(,\s*[^"'<>;]*)?\)|[a-zA-Z]+)$/.test(c)) {
      return c;
    }
    return fallback;
  }

  // ─── SVG pie ───────────────────────────────────────────────────────────────

  _buildPie(values, colors) {
    const total = values.reduce((a, b) => a + b, 0);
    const r = 52, ri = 34, cx = 60, cy = 60;
    const strokeW = r - ri;
    const rMid    = (r + ri) / 2;

    if (total === 0) {
      return `<circle cx="${cx}" cy="${cy}" r="${rMid}" fill="none"
        stroke="var(--divider-color, rgba(0,0,0,.1))" stroke-width="${strokeW}"/>`;
    }

    // Single-slice fix: one segment with a value → full ring in that color
    const activeCount = values.filter(v => v > 0).length;
    if (activeCount === 1) {
      const i = values.findIndex(v => v > 0);
      return `<circle cx="${cx}" cy="${cy}" r="${rMid}" fill="none"
        stroke="${this._safeColor(colors[i])}" stroke-width="${strokeW}" class="slice" data-index="${i}"/>`;
    }

    const gap = 0.045;
    let angle = -Math.PI / 2;
    return values.map((v, i) => {
      if (v <= 0) return "";
      const slice = (v / total) * 2 * Math.PI - gap;
      if (slice < 0.01) return "";
      const cos = Math.cos, sin = Math.sin;
      const x1  = cx + r  * cos(angle),        y1  = cy + r  * sin(angle);
      const x2  = cx + r  * cos(angle + slice), y2  = cy + r  * sin(angle + slice);
      const xi1 = cx + ri * cos(angle),         yi1 = cy + ri * sin(angle);
      const xi2 = cx + ri * cos(angle + slice), yi2 = cy + ri * sin(angle + slice);
      const lg  = slice > Math.PI ? 1 : 0;
      const d   = `M${xi1} ${yi1} L${x1} ${y1} A${r} ${r} 0 ${lg} 1 ${x2} ${y2} L${xi2} ${yi2} A${ri} ${ri} 0 ${lg} 0 ${xi1} ${yi1}Z`;
      angle += slice + gap;
      return `<path d="${d}" fill="${this._safeColor(colors[i])}" class="slice" data-index="${i}"/>`;
    }).join("");
  }

  // ─── Main render ───────────────────────────────────────────────────────────

  /** Injects the static <style> + content container once — never touched again by _render(). */
  _ensureShell() {
    if (this.shadowRoot.getElementById("content")) return;
    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; container-type: inline-size; }
        ha-card { padding: 14px 16px 16px; background: var(--card-background-color, #fff); }

        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 8px; }
        .title { font-size: 13px; font-weight: 500; color: var(--primary-text-color); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        .nav { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .nav-btn {
          width: 28px; height: 28px; border: none; background: transparent; border-radius: 6px;
          cursor: pointer; color: var(--primary-text-color); display: flex; align-items: center;
          justify-content: center; padding: 0; opacity: .7;
          transition: background .15s, opacity .15s; -webkit-tap-highlight-color: transparent;
        }
        .nav-btn:hover { background: var(--secondary-background-color, rgba(0,0,0,.06)); opacity: 1; }
        .nav-btn:disabled { opacity: .25; cursor: default; }
        .nav-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        .date-label {
          font-size: 12px; color: var(--secondary-text-color); min-width: 56px; text-align: center;
          cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background .15s; user-select: none;
        }
        .date-label:hover { background: var(--secondary-background-color, rgba(0,0,0,.06)); }
        input[type="date"] { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }

        .chart-area { display: flex; align-items: center; gap: 16px; }
        .pie-wrap { position: relative; width: 120px; height: 120px; flex-shrink: 0; }
        svg.pie { display: block; }
        .slice { transition: opacity .15s; cursor: default; }
        .slice:hover { opacity: .75; }
        .center {
          position: absolute; top: 50%; left: 50%;
          transform: translate(-50%, -50%); text-align: center; pointer-events: none; line-height: 1;
        }
        .center-kwh { font-size: 16px; font-weight: 600; color: var(--primary-text-color); }
        .center-sub { font-size: 10px; color: var(--secondary-text-color); margin-top: 3px; }

        .legend { flex: 1; min-width: 0; }
        .leg-row { display: flex; align-items: center; gap: 7px; padding: 3px 0; }
        .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
        .leg-label { font-size: 12px; color: var(--secondary-text-color); flex: 1; }
        .leg-val { font-size: 12px; font-weight: 500; color: var(--primary-text-color); min-width: 48px; text-align: right; }
        .leg-pct { font-size: 11px; color: var(--disabled-text-color, rgba(0,0,0,.38)); min-width: 30px; text-align: right; }

        /* Narrow card (e.g. sidebar panel): stack the pie above the legend instead of squeezing both side by side. */
        @container (max-width: 260px) {
          .chart-area { flex-direction: column; align-items: center; }
          .legend { width: 100%; }
        }

        .total-row {
          display: flex; justify-content: space-between; align-items: center;
          margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
        }
        .total-lbl { font-size: 12px; color: var(--secondary-text-color); }
        .total-val { font-size: 15px; font-weight: 600; color: var(--success-color, #4CAF50); }

        .loading-overlay {
          display: flex; align-items: center; justify-content: center;
          height: 80px; color: var(--secondary-text-color); font-size: 13px; gap: 8px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner {
          width: 16px; height: 16px;
          border: 2px solid var(--divider-color, rgba(0,0,0,.12));
          border-top-color: var(--primary-color, #03a9f4);
          border-radius: 50%; animation: spin .7s linear infinite;
        }
        .error-msg { font-size: 11px; color: var(--error-color, #f44336); text-align: center; padding: 4px 0; }
        .purge-warning { font-size: 10px; color: var(--warning-color, #ff9800); text-align: center; padding: 4px 0; margin-top: 6px; }
      </style>
      <div id="content"></div>
    `;
  }

  _render(values = [0, 0, 0], error = false, purged = false) {
    const cfg = this._config;
    if (!cfg) return;
    this._ensureShell();

    const colors      = cfg.colors;
    const labels      = ["00–08", "08–16", "16–24"];
    const total       = values.reduce((a, b) => a + b, 0);
    const pct         = (i) => total > 0 ? Math.round(values[i] / total * 100) : 0;
    const dateStr     = this._selectedDate || this._localDateStr();
    const displayDate = this._displayDate(dateStr);
    const isToday     = dateStr === this._localDateStr();
    const pieHTML     = this._buildPie(values, colors);

    const legendRows = labels.map((l, i) => `
      <div class="leg-row">
        <span class="dot" style="background:${colors[i]}"></span>
        <span class="leg-label">${l}</span>
        <span class="leg-val">${this._loading ? "…" : values[i].toFixed(2)}</span>
        <span class="leg-pct">${this._loading ? "" : pct(i) + "%"}</span>
      </div>`).join("");

    this.shadowRoot.getElementById("content").innerHTML = `
      <ha-card>
        <div class="header">
          <span class="title">${this._esc(cfg.title)}</span>
          ${this._static ? "" : `
            <div class="nav">
              <button class="nav-btn" id="btn-back" title="Previous day" aria-label="Previous day" ${!this._canGoBack() ? "disabled" : ""}>
                <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <span class="date-label" id="date-label" title="Choose date" role="button" tabindex="0" aria-label="Choose date: ${displayDate}">${displayDate}</span>
              <input type="date" id="date-picker"
                value="${dateStr}"
                min="${this._offsetDate(this._localDateStr(), -cfg.max_days_back)}"
                max="${this._localDateStr()}">
              <button class="nav-btn" id="btn-fwd" title="Next day" aria-label="Next day" ${!this._canGoForward() ? "disabled" : ""}>
                <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          `}
        </div>

        ${this._loading ? `
          <div class="loading-overlay"><div class="spinner"></div> Fetching history…</div>
        ` : error ? `
          <div class="error-msg">⚠ Could not fetch history. Check the entity ID and that HA's recorder is active.</div>
        ` : `
          <div class="chart-area">
            <div class="pie-wrap">
              <svg class="pie" width="120" height="120" viewBox="0 0 120 120">${pieHTML}</svg>
              <div class="center">
                <div class="center-kwh">${total.toFixed(2)}</div>
                <div class="center-sub">kWh</div>
              </div>
            </div>
            <div class="legend">${legendRows}</div>
          </div>
          <div class="total-row">
            <span class="total-lbl">Total ${isToday ? "today" : displayDate.toLowerCase()}</span>
            <span class="total-val">${total.toFixed(2)} kWh</span>
          </div>
          ${purged ? `<div class="purge-warning">⚠ No history — check recorder purge_keep_days</div>` : ""}
        `}
      </ha-card>
    `;

    // ── Event listeners (interactive mode only) ──
    if (!this._static) {
      this.shadowRoot.getElementById("btn-back")?.addEventListener("click", () => {
        this._selectedDate = this._offsetDate(dateStr, -1);
        this._loadAndRender();
      });
      this.shadowRoot.getElementById("btn-fwd")?.addEventListener("click", () => {
        const next = this._offsetDate(dateStr, 1);
        this._selectedDate = next >= this._localDateStr() ? null : next;
        this._loadAndRender();
      });
      const dateLbl    = this.shadowRoot.getElementById("date-label");
      const datePicker = this.shadowRoot.getElementById("date-picker");
      const openDatePicker = () => datePicker?.showPicker?.() || datePicker?.click();
      dateLbl?.addEventListener("click", openDatePicker);
      dateLbl?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDatePicker(); }
      });
      datePicker?.addEventListener("change", (e) => {
        const val = e.target.value;
        this._selectedDate = val >= this._localDateStr() ? null : val;
        this._loadAndRender();
      });
    }
  }

  getCardSize() { return 3; }
}

customElements.define("electricity-pie-card", ElectricityPieCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "electricity-pie-card",
  name: "Electricity Pie Card",
  description: "Electricity consumption per 8h period with history",
});

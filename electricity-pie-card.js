/**
 * electricity-pie-card
 * Pie chart för elförbrukning per 8h-period.
 * Hämtar historik direkt via HA History API – ingen ApexCharts.
 *
 * Konfiguration:
 *   type: custom:electricity-pie-card
 *   entity: sensor.dsmr_reading_electricity_delivered_1
 *   title: Förbrukning idag        # valfri
 *   max_days_back: 30              # valfri, default 30
 *   colors:                        # valfri
 *     - "#5B8AF5"
 *     - "#F5A623"
 *     - "#7ED321"
 */

class ElectricityPieCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._selectedDate = null; // null = idag
    this._cache = {};          // "YYYY-MM-DD" -> [v0, v1, v2]
    this._loading = false;
  }

  setConfig(config) {
    if (!config.entity) throw new Error("entity krävs");
    this._config = {
      entity: config.entity,
      title: config.title || "Elförbrukning",
      max_days_back: config.max_days_back ?? 30,
      colors: config.colors || ["#5B8AF5", "#F5A623", "#7ED321"],
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // Första gången – ladda data för idag
    if (!this._initialized) {
      this._initialized = true;
      this._loadAndRender();
    }
  }

  // ─── Date helpers ──────────────────────────────────────────────────────────

  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  _dateStr(date) {
    return date.toISOString().slice(0, 10);
  }

  _displayDate(dateStr) {
    if (!dateStr || dateStr === this._todayStr()) return "Idag";
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (dateStr === this._dateStr(yesterday)) return "Igår";
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("sv-SE", { weekday: "short", month: "short", day: "numeric" });
  }

  _offsetDate(dateStr, days) {
    const d = new Date((dateStr || this._todayStr()) + "T12:00:00");
    d.setDate(d.getDate() + days);
    return this._dateStr(d);
  }

  _canGoForward() {
    return this._selectedDate && this._selectedDate < this._todayStr();
  }

  _canGoBack() {
    if (!this._selectedDate) {
      // idag -> kan gå max_days_back bakåt
      return true;
    }
    const minDate = this._offsetDate(this._todayStr(), -this._config.max_days_back);
    return this._selectedDate > minDate;
  }

  // ─── History API ───────────────────────────────────────────────────────────

  async _fetchPeriodValues(dateStr) {
    if (this._cache[dateStr]) return this._cache[dateStr];

    const entity = this._config.entity;

    // Bygg start/slut för hela dagen
    const dayStart = new Date(dateStr + "T00:00:00");
    const dayEnd   = new Date(dateStr + "T23:59:59");

    // Hämta historik för hela dagen + lite marginal bakåt (för att diff ska funka)
    const fetchFrom = new Date(dayStart.getTime() - 60 * 60 * 1000); // 1h marginal
    const startISO  = fetchFrom.toISOString();
    const endISO    = dayEnd.toISOString();

    const url = `/api/history/period/${startISO}?filter_entity_id=${entity}&end_time=${endISO}&minimal_response=true&no_attributes=true`;

    const resp = await this._hass.callApi("GET", url.slice(5)); // ta bort /api/ prefix
    // callApi prefixar /api/ automatiskt, så vi skippar det

    const history = resp?.[0] ?? [];
    if (history.length < 2) return [0, 0, 0];

    // Konvertera states till tidsstämpel + värde
    const points = history
      .map(s => ({ t: new Date(s.last_changed || s.lu * 1000).getTime(), v: parseFloat(s.state) }))
      .filter(p => !isNaN(p.v))
      .sort((a, b) => a.t - b.t);

    if (points.length < 2) return [0, 0, 0];

    // Beräkna diff för tre 8h-perioder
    const periods = [
      { start: new Date(dateStr + "T00:00:00").getTime(), end: new Date(dateStr + "T08:00:00").getTime() },
      { start: new Date(dateStr + "T08:00:00").getTime(), end: new Date(dateStr + "T16:00:00").getTime() },
      { start: new Date(dateStr + "T16:00:00").getTime(), end: new Date(dateStr + "T23:59:59").getTime() },
    ];

    const values = periods.map(period => {
      // Hitta närmaste värde före/vid period start och slut
      const getValueAt = (t) => {
        let best = null;
        for (const p of points) {
          if (p.t <= t) best = p;
          else break;
        }
        return best?.v ?? null;
      };
      const vStart = getValueAt(period.start);
      const vEnd   = getValueAt(period.end);
      if (vStart === null || vEnd === null) return 0;
      return Math.max(0, parseFloat((vEnd - vStart).toFixed(3)));
    });

    this._cache[dateStr] = values;
    return values;
  }

  // ─── Load + render ─────────────────────────────────────────────────────────

  async _loadAndRender() {
    if (!this._hass || !this._config) return;
    this._loading = true;
    this._render();

    const dateStr = this._selectedDate || this._todayStr();
    try {
      const values = await this._fetchPeriodValues(dateStr);
      this._loading = false;
      this._render(values);
    } catch (e) {
      console.error("electricity-pie-card: fel vid historik-hämtning", e);
      this._loading = false;
      this._render([0, 0, 0], true);
    }
  }

  // ─── SVG pie ───────────────────────────────────────────────────────────────

  _buildPie(values, colors) {
    const total = values.reduce((a, b) => a + b, 0);
    if (total === 0) {
      // Tom ring
      return `<circle cx="60" cy="60" r="43" fill="none" stroke="var(--divider-color, rgba(0,0,0,.1))" stroke-width="18"/>`;
    }
    const gap = 0.045;
    let angle = -Math.PI / 2;
    const r = 52, ri = 34, cx = 60, cy = 60;
    return values.map((v, i) => {
      const slice = (v / total) * 2 * Math.PI - gap;
      if (slice <= 0.01) return "";
      const cos = Math.cos, sin = Math.sin;
      const x1 = cx + r * cos(angle),   y1 = cy + r * sin(angle);
      const x2 = cx + r * cos(angle + slice), y2 = cy + r * sin(angle + slice);
      const xi1 = cx + ri * cos(angle), yi1 = cy + ri * sin(angle);
      const xi2 = cx + ri * cos(angle + slice), yi2 = cy + ri * sin(angle + slice);
      const lg = slice > Math.PI ? 1 : 0;
      const d = `M${xi1} ${yi1} L${x1} ${y1} A${r} ${r} 0 ${lg} 1 ${x2} ${y2} L${xi2} ${yi2} A${ri} ${ri} 0 ${lg} 0 ${xi1} ${yi1}Z`;
      angle += slice + gap;
      return `<path d="${d}" fill="${colors[i]}" class="slice" data-index="${i}"/>`;
    }).join("");
  }

  // ─── Main render ───────────────────────────────────────────────────────────

  _render(values = [0, 0, 0], error = false) {
    const cfg = this._config;
    if (!cfg) return;

    const colors = cfg.colors;
    const labels = ["00–08", "08–16", "16–24"];
    const total  = values.reduce((a, b) => a + b, 0);
    const pct    = (i) => total > 0 ? Math.round(values[i] / total * 100) : 0;

    const dateStr     = this._selectedDate || this._todayStr();
    const displayDate = this._displayDate(dateStr);
    const isToday     = dateStr === this._todayStr();

    const pieHTML = this._buildPie(values, colors);

    const legendRows = labels.map((l, i) => `
      <div class="leg-row">
        <span class="dot" style="background:${colors[i]}"></span>
        <span class="leg-label">${l}</span>
        <span class="leg-val">${this._loading ? "…" : values[i].toFixed(2)}</span>
        <span class="leg-pct">${this._loading ? "" : pct(i) + "%"}</span>
      </div>`).join("");

    this.shadowRoot.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :host { display: block; }

        ha-card {
          padding: 14px 16px 16px;
          background: var(--card-background-color, #fff);
        }

        /* ── Header ── */
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
          gap: 8px;
        }
        .title {
          font-size: 13px;
          font-weight: 500;
          color: var(--primary-text-color);
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* ── Date navigation ── */
        .nav {
          display: flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }
        .nav-btn {
          width: 28px; height: 28px;
          border: none;
          background: transparent;
          border-radius: 6px;
          cursor: pointer;
          color: var(--primary-text-color);
          display: flex; align-items: center; justify-content: center;
          padding: 0;
          opacity: .7;
          transition: background .15s, opacity .15s;
          -webkit-tap-highlight-color: transparent;
        }
        .nav-btn:hover { background: var(--secondary-background-color, rgba(0,0,0,.06)); opacity: 1; }
        .nav-btn:disabled { opacity: .25; cursor: default; }
        .nav-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        .date-label {
          font-size: 12px;
          color: var(--secondary-text-color);
          min-width: 56px;
          text-align: center;
          cursor: pointer;
          padding: 2px 4px;
          border-radius: 4px;
          transition: background .15s;
          user-select: none;
        }
        .date-label:hover { background: var(--secondary-background-color, rgba(0,0,0,.06)); }
        input[type="date"] {
          position: absolute;
          opacity: 0;
          pointer-events: none;
          width: 0; height: 0;
        }

        /* ── Chart area ── */
        .chart-area {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .pie-wrap {
          position: relative;
          width: 120px;
          height: 120px;
          flex-shrink: 0;
        }
        svg.pie { display: block; }
        .slice { transition: opacity .15s; cursor: default; }
        .slice:hover { opacity: .75; }
        .center {
          position: absolute;
          top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          text-align: center;
          pointer-events: none;
          line-height: 1;
        }
        .center-kwh {
          font-size: 16px;
          font-weight: 600;
          color: var(--primary-text-color);
        }
        .center-sub {
          font-size: 10px;
          color: var(--secondary-text-color);
          margin-top: 3px;
        }

        /* ── Legend ── */
        .legend { flex: 1; min-width: 0; }
        .leg-row {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 3px 0;
        }
        .dot {
          width: 9px; height: 9px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .leg-label {
          font-size: 12px;
          color: var(--secondary-text-color);
          flex: 1;
        }
        .leg-val {
          font-size: 12px;
          font-weight: 500;
          color: var(--primary-text-color);
          min-width: 48px;
          text-align: right;
        }
        .leg-pct {
          font-size: 11px;
          color: var(--disabled-text-color, rgba(0,0,0,.38));
          min-width: 30px;
          text-align: right;
        }

        /* ── Total ── */
        .total-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 11px;
          padding-top: 9px;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
        }
        .total-lbl {
          font-size: 12px;
          color: var(--secondary-text-color);
        }
        .total-val {
          font-size: 15px;
          font-weight: 600;
          color: var(--success-color, #4CAF50);
        }

        /* ── Loading / error ── */
        .loading-overlay {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 80px;
          color: var(--secondary-text-color);
          font-size: 13px;
          gap: 8px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .spinner {
          width: 16px; height: 16px;
          border: 2px solid var(--divider-color, rgba(0,0,0,.12));
          border-top-color: var(--primary-color, #03a9f4);
          border-radius: 50%;
          animation: spin .7s linear infinite;
        }
        .error-msg {
          font-size: 11px;
          color: var(--error-color, #f44336);
          text-align: center;
          padding: 4px 0;
        }
      </style>

      <ha-card>
        <div class="header">
          <span class="title">${cfg.title}</span>
          <div class="nav">
            <button class="nav-btn" id="btn-back" title="Föregående dag"
              ${!this._canGoBack() ? "disabled" : ""}>
              <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span class="date-label" id="date-label" title="Välj datum">${displayDate}</span>
            <input type="date" id="date-picker"
              value="${dateStr}"
              min="${this._offsetDate(this._todayStr(), -cfg.max_days_back)}"
              max="${this._todayStr()}">
            <button class="nav-btn" id="btn-fwd" title="Nästa dag"
              ${!this._canGoForward() ? "disabled" : ""}>
              <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>

        ${this._loading ? `
          <div class="loading-overlay"><div class="spinner"></div> Hämtar historik…</div>
        ` : error ? `
          <div class="error-msg">Kunde inte hämta historik. Kontrollera entity-id.</div>
        ` : `
          <div class="chart-area">
            <div class="pie-wrap">
              <svg class="pie" width="120" height="120" viewBox="0 0 120 120">
                ${pieHTML}
              </svg>
              <div class="center">
                <div class="center-kwh">${total.toFixed(2)}</div>
                <div class="center-sub">kWh</div>
              </div>
            </div>
            <div class="legend">${legendRows}</div>
          </div>
          <div class="total-row">
            <span class="total-lbl">Total ${isToday ? "idag" : displayDate.toLowerCase()}</span>
            <span class="total-val">${total.toFixed(2)} kWh</span>
          </div>
        `}
      </ha-card>
    `;

    // ── Event listeners ──
    this.shadowRoot.getElementById("btn-back")?.addEventListener("click", () => {
      this._selectedDate = this._offsetDate(dateStr, -1);
      this._loadAndRender();
    });

    this.shadowRoot.getElementById("btn-fwd")?.addEventListener("click", () => {
      const next = this._offsetDate(dateStr, 1);
      this._selectedDate = next >= this._todayStr() ? null : next;
      this._loadAndRender();
    });

    const dateLbl    = this.shadowRoot.getElementById("date-label");
    const datePicker = this.shadowRoot.getElementById("date-picker");

    dateLbl?.addEventListener("click", () => datePicker?.showPicker?.() || datePicker?.click());
    datePicker?.addEventListener("change", (e) => {
      const val = e.target.value;
      this._selectedDate = val >= this._todayStr() ? null : val;
      this._loadAndRender();
    });
  }

  getCardSize() { return 3; }
}

customElements.define("electricity-pie-card", ElectricityPieCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "electricity-pie-card",
  name: "Electricity Pie Card",
  description: "Elförbrukning per 8h-period med historik",
});

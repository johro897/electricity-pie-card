# Electricity Pie Card for Home Assistant

A lightweight, custom Home Assistant card that visualizes your electricity consumption across different times of the day using a sleek pie chart. The card breaks the day down into three logical 8-hour periods: **Night (00:00–08:00)**, **Day (08:00–16:00)**, and **Evening (16:00–24:00)**.

Unlike many other custom cards, this card requires no external dependencies (like ApexCharts). Instead, it renders everything using efficient, native SVG graphics and fetches history data directly through the Home Assistant History API.

![](screenshots/overview_pie_card.png)
---

## Features

- Donut pie chart split into periods: **00–08**, **08–16**, **16–24**
- Fetches data directly from the HA History API (no ApexCharts, no external dependencies)
- Two modes:
  - **Interactive** — date navigation with arrows and a date picker
  - **Static** — locked to a specific day via `offset` (no UI controls shown)
- Live updates for today's card when the sensor value changes
- Correct timezone handling — uses local time in all API calls
- Warning displayed if data is missing due to recorder `purge_keep_days`
- Single-segment pie renders correctly as a full ring
- Configurable colors, title, and max days back
- UI auto-translates to your Home Assistant language — English, Swedish, French, or German (falls back to English)
- Registers with `window.customCards` for the HA card picker

---

## Installation

1. Copy `electricity-pie-card.js` to `/config/www/electricity-pie-card.js`

2. Add the resource in `configuration.yaml`:

```yaml
lovelace:
  resources:
    - url: /local/electricity-pie-card.js
      type: module
```

Or via the UI: **Settings → Dashboards → ⋮ → Resources → Add resource**

3. Restart Home Assistant (or reload resources).

---

## Configuration

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `entity` | string | **required** | The accumulating energy meter sensor (see note below) |
| `title` | string | *(none — auto-translated, e.g. "Electricity consumption" / "Elförbrukning")* | Card title |
| `offset` | integer | *(not set)* | Days relative to today: `0` = today, `-1` = yesterday, `-2` = two days ago. When set, the card is **static** (no date navigation shown) |
| `max_days_back` | integer | `30` | How many days back the date picker allows. Ignored when `offset` is set. See note on recorder below. |
| `colors` | list | `["#5B8AF5","#F5A623","#7ED321"]` | Colors for the three periods |

> **Note on `max_days_back`:** This is limited by Home Assistant's recorder `purge_keep_days` setting (default: **10 days**). If you navigate to a date outside the recorder window, the card will show a warning. To increase history retention, set `purge_keep_days` in your recorder config.

---

### Examples

**Interactive card — today with date navigation:**
```yaml
type: custom:electricity-pie-card
entity: sensor.dsmr_reading_electricity_delivered_1
title: Consumption today
max_days_back: 30
```

**Static card — always shows yesterday:**
```yaml
type: custom:electricity-pie-card
entity: sensor.dsmr_reading_electricity_delivered_1
title: Yesterday
offset: -1
```

**Static card — two days ago:**
```yaml
type: custom:electricity-pie-card
entity: sensor.dsmr_reading_electricity_delivered_1
title: Two days ago
offset: -2
```

**Interactive with extended history (requires recorder config):**
```yaml
type: custom:electricity-pie-card
entity: sensor.dsmr_reading_electricity_delivered_1
title: History
max_days_back: 90
colors:
  - "#E57373"
  - "#FFB74D"
  - "#81C784"
```

---

## How it works

The card calls HA's built-in `/api/history/period/` endpoint directly. It fetches raw state values for the sensor and sums up the increases between consecutive readings within each 8-hour period, locally in JavaScript — any drop between readings is treated as a meter reset (e.g. a "today" counter zeroing overnight) rather than negative production, so a reset landing inside a period doesn't erase real production from the total.

All API calls use **local time** (no UTC offset issues). Historical days are cached in memory for the session. Today's data is never cached and re-fetches whenever the sensor state changes.

> **What kind of sensor works here:** `entity` needs to be a **monotonically accumulating meter** — a value that only ever counts up over the course of a day (optionally resetting to zero, e.g. a solar inverter's "today" production counter). Examples: a DSMR delivered-energy register, a solar inverter's daily production sensor. This card is **not** built for bidirectional "net" values that can legitimately go negative (e.g. a grid import/export balance that's negative while exporting and positive while importing) — there's no sensible way to chart "how much happened in this period" from a value that swings both directions without losing information. If you have separate accumulating sensors for import and export instead of one net value, use two instances of this card, one per sensor.

---

## Recorder configuration (optional)

To extend history beyond the default 10 days, add to `configuration.yaml`:

```yaml
recorder:
  purge_keep_days: 90
```

---

## Changelog

### v1.5
**Fix: production during the first period could silently disappear** — [#9](https://github.com/johro897/electricity-pie-card/issues/9)
- If your sensor stops reporting overnight (typical for a solar inverter with no production after dark) and its "today" counter resets once it wakes up, the card could compute a negative diff for the 00–08 period and clamp it to zero — silently losing that period's real production from the total, reported against a Goodwe PV inverter
- The period calculation is now reset-aware: it walks the recorded history and sums only genuine increases between consecutive readings, treating any drop as a meter reset rather than negative production, instead of a simple start/end diff per period
- No change for accumulating meters that never reset (e.g. DSMR) — verified the new calculation produces identical results to the previous one for that case

### v1.4
**Language support** — [#8](https://github.com/johro897/electricity-pie-card/issues/8)
- All rendered UI text (nav buttons, date picker, loading/error messages, the "Total" row, the default title, and the config-validation error) now auto-translates based on your Home Assistant instance's configured language
- Supported languages: **English** (default), **Swedish**, **French**, **German** — falls back to English for any other language
- Fixes the original report: the card's UI text used to be hardcoded in Swedish regardless of your HA language, which was confusing for non-Swedish users
- The date label (e.g. "Tue, Aug 18") also correctly follows your HA language via the browser's native date formatting, rather than always using Swedish weekday/month names

**Hardening: capped the live-update debounce** — [#10](https://github.com/johro897/electricity-pie-card/issues/10)
- Today's live update is debounced by 2 seconds so a fast-changing sensor doesn't trigger a history fetch on every single tick — but that debounce had no upper bound, so a sensor updating more often than every 2 seconds (e.g. some DSMR/P1 meters) could in theory keep deferring the reload indefinitely. It's now capped so a refresh is forced at least every 10 seconds even under continuous updates.
- Investigated after a reported mismatch between the card's "today" total and Home Assistant's Energy dashboard — that specific mismatch turned out to be explained by the Energy dashboard lagging behind on its hourly statistics, not a bug in the card (confirmed against raw meter readings), so this is a preventive hardening fix rather than a confirmed data-correctness fix

### v1.3
**Security hardening** — [#1](https://github.com/johro897/electricity-pie-card/issues/1)
- The card title is now HTML-escaped, and configured `colors` values are now validated to actually look like a CSS color before being used — previously both were inserted into the card's markup as-is, so a crafted value in a shared/pasted dashboard YAML could break out of an attribute or inject markup

**Performance** — [#2](https://github.com/johro897/electricity-pie-card/issues/2)
- The static `<style>` block is now injected once instead of being reparsed on every render — regular renders now only replace the dynamic content, not the whole shadow DOM
- Live updates (when the sensor's state changes while viewing today) are now debounced by 2 seconds instead of triggering an immediate history fetch on every single tick

**Accessibility & responsive layout** — [#3](https://github.com/johro897/electricity-pie-card/issues/3)
- The back/forward day-navigation buttons now have an `aria-label`, not just a `title`
- The date label is now keyboard-operable — reachable via Tab, opens the date picker with Enter or Space
- On a narrow card (e.g. a sidebar panel), the pie chart now stacks above the legend instead of squeezing both into a cramped side-by-side layout

### v1.0
- Initial release
- Donut pie chart with three 8-hour periods
- Interactive mode with date picker and arrow navigation
- Static mode via `offset` parameter
- Direct HA History API integration — no ApexCharts dependency
- Configurable colors, title, max days back
- Registers with `window.customCards`

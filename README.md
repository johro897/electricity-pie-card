# Electricity Pie Card for Home Assistant

A lightweight, custom Home Assistant card that visualizes your electricity consumption across different times of the day using a sleek pie chart. The card breaks the day down into three logical 8-hour periods: **Night (00:00–08:00)**, **Day (08:00–16:00)**, and **Evening (16:00–24:00)**.

Unlike many other custom cards, this card requires no external dependencies (like ApexCharts). Instead, it renders everything using efficient, native SVG graphics and fetches history data directly through the Home Assistant History API.

## Features

* **Period Breakdown:** Instantly see when during the day you consume the most energy.
* **History Browsing:** Easily navigate back and forth in time using arrows, or pick a specific date via the native calendar date picker.
* **High Performance:** Built with vanilla JavaScript/Web Components—no heavy libraries to slow down your dashboard.
* **Responsive Design:** Adapts seamlessly to your current Home Assistant theme, utilizing core CSS variables for text, backgrounds, and accents.
* **Caching:** Caches fetched history data locally within the session to minimize redundant API calls while toggling between days.

## Installation

1. Save the code as `electricity-pie-card.js` inside your Home Assistant `/config/www/` directory.
2. Add the file as a Dashboard resource:
* Navigate to **Settings** -> **Dashboards**.
* Click the three dots in the top-right corner -> **Resources**.
* Click **Add Resource** and enter `/local/electricity-pie-card.js` as the URL.
* Set the Resource Type to **JavaScript Module**.


3. Refresh your browser page or restart Home Assistant.

## Configuration

You can add this card using the visual dashboard editor (by searching for "Manual" or "Custom") or directly via YAML:

```yaml
type: custom:electricity-pie-card
entity: sensor.dsmr_reading_electricity_delivered_1  # Your cumulative energy sensor
title: "My Power Consumption"                        # Optional title
max_days_back: 30                                    # Optional (limited by your Recorder settings)
colors:                                              # Optional custom hex colors
  - "#5B8AF5" # 00:00 - 08:00
  - "#F5A623" # 08:00 - 16:00
  - "#7ED321" # 16:00 - 24:00

```

## Requirements

* **Entity:** The card requires a sensor that tracks **cumulative energy** (i.e., a non-resetting meter reading in kWh that continuously increases). This is ideal for HAN/P1 port readers or smart meter integrations.
* **History:** The card relies heavily on the Home Assistant `recorder` component. If you want to look 30 days back, your `recorder` component must be configured to retain history for at least 30 days (`purge_keep_days`).

## Technical Overview

The card calculates consumption by fetching the exact state of the meter at the start and end of each 8-hour window and determining the difference:


$$Consumption = V_{end} - V_{start}$$

Because it targets specific timestamps in your history, it calculates exact consumption regardless of how frequently or infrequently your smart meter sends data updates.

---

**Tip:** If you are using this card to optimize your energy consumption against spot-prices (hourly tariffs), this visualization makes it incredibly easy to see how much of your daily load can be shifted away from peak hours (typically 08:00–16:00) into cheaper slots.

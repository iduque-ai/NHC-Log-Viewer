# NHC Log Viewer

## Overview

NHC Log Viewer is an interactive web application designed to parse, filter, and analyze application log files. Built with performance and privacy in mind, it processes all data locally in your browser, no logs are ever uploaded to a server.

It provides powerful tools for developers and system administrators to quickly diagnose issues, visualize log distributions, and perform deep-dive analysis on complex log files.

## Key Features

*   **🔒 Privacy Focused**: 100% client-side processing. Your logs never leave your device.
*   **📂 Multi-Format Support**:
    *   Supports `.log` and `.txt` files.
    *   Native support for compressed archives: `.zip` and `.gz` (GZIP).
*   **🤖 AI Assistant**: Chat with your logs! Use Google's Gemini models for deep analysis, or run models like Llama 3 entirely on-device for complete privacy.
*   **🔍 Advanced Search & Filtering**:
    *   **Boolean Logic**: Use complex queries like `(error || warning) && !network`.
    *   **Regex Support**: Full Regular Expression capabilities.
    *   **Granular Filters**: Filter by Log Level, Daemon, Module, Function Name, and specific Date Ranges.
*   **📊 Visualization Dashboard**:
    *   View error rates and log volume over time.
    *   Analyze distribution by log level and top-occurring daemons/functions.
*   **📱 Responsive Design**:
    *   Dense table view for desktop analysis.
    *   Card-based view for mobile debugging.

## Supported Formats

The application automatically detects and parses:
*   **Standard Syslog**: `Sep 11 12:00:00 hostname daemon[123]: message`
*   **Asterisk Logs**: Detailed logs including file/line numbers and function names.
*   **ISO 8601**: Logs using `YYYY-MM-DD` timestamps.

## Getting Started

### Prerequisites

*   Node.js (v18 or higher recommended)

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/your-repo/nhc-log-viewer.git
    cd nhc-log-viewer
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Start the development server:
    ```bash
    npm run dev
    ```

4.  Open `http://localhost:5173` in your browser.

## Tech Stack

*   **Framework**: React (TypeScript)
*   **Build Tool**: Vite
*   **Styling**: Tailwind CSS
*   **AI (Cloud)**: Google Gemini (`@google/genai`)
*   **AI (Local)**: WebLLM / Llama 3 (`@mlc-ai/web-llm`)
*   **Charts**: Chart.js
*   **Compression**: JSZip, Pako
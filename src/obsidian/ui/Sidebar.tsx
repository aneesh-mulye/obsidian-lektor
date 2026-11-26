// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The sidebar's three zones (DESIGN.md § UI). Empty until the chat milestone. */
export function Sidebar() {
  return (
    <div className="lektor-sidebar">
      <div className="lektor-header" />
      <div className="lektor-conversation">
        <p className="lektor-placeholder">Nothing here yet.</p>
      </div>
      <div className="lektor-composer" />
    </div>
  );
}

// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A fuzzy picker over a fixed list, for the command-palette versions of the header's menus (INVARIANTS.md U2). */

import { type App, FuzzySuggestModal } from 'obsidian';

export class ChoiceModal<T> extends FuzzySuggestModal<T> {
  constructor(
    app: App,
    private readonly items: readonly T[],
    private readonly label: (item: T) => string,
    private readonly onPick: (item: T) => void,
    placeholder: string,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): T[] {
    return [...this.items];
  }

  getItemText(item: T): string {
    return this.label(item);
  }

  onChooseItem(item: T): void {
    this.onPick(item);
  }
}

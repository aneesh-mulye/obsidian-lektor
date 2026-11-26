// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sidebar, type SidebarProps } from './ui/Sidebar';

export const VIEW_TYPE_LEKTOR = 'lektor-chat';

/** The right-sidebar view. Hosts the React tree; holds no vault access of its own. */
export class LektorView extends ItemView {
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly props: SidebarProps,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_LEKTOR;
  }

  override getDisplayText(): string {
    return 'Lektor';
  }

  override getIcon(): string {
    return 'message-square';
  }

  override onOpen(): Promise<void> {
    this.contentEl.addClass('lektor-view');
    this.root = createRoot(this.contentEl);
    this.root.render(
      <StrictMode>
        <Sidebar {...this.props} />
      </StrictMode>,
    );
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    return Promise.resolve();
  }
}

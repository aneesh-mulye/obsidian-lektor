// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { setIcon } from 'obsidian';
import { type MouseEvent, useEffect, useRef } from 'react';

/** A Lucide icon from Obsidian's bundled set. */
export function Icon({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    setIcon(el, name);
  }, [name]);
  return <span className="lektor-icon" ref={ref} aria-hidden="true" />;
}

/** An icon-only button. `label` is its tooltip and accessible name. */
export function IconButton(props: {
  icon: string;
  label: string;
  onClick: (ev: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`clickable-icon lektor-icon-button${props.active ? ' is-active' : ''}${props.className ? ` ${props.className}` : ''}`}
      aria-label={props.label}
      data-tooltip-position="bottom"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

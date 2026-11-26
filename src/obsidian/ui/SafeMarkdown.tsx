// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from 'react';
import { renderSafeMarkdown } from './markdown';

/**
 * Renders model output. The only file allowed `dangerouslySetInnerHTML`
 * (eslint/gates.mjs, G7); its input is always renderSafeMarkdown's output (R1).
 */
export function SafeMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderSafeMarkdown(text), [text]);
  return <div className="lektor-markdown markdown-rendered" dangerouslySetInnerHTML={{ __html: html }} />;
}

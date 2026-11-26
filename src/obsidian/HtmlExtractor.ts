// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Readable text from a fetched page, for fetch_page. The page is parsed with
 * DOMParser into an inert document (no scripts run, nothing loads) and
 * reduced to text by Mozilla's Readability; if that finds no article, the
 * body's text is used. Nothing here touches the live DOM.
 */

import { Readability } from '@mozilla/readability';
import type { HtmlExtractor } from '../core/tools/web';

export const readabilityExtractor: HtmlExtractor = {
  extract(html: string) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.title.trim();
    const article = new Readability(doc, { charThreshold: 200 }).parse();
    const text = (article?.textContent ?? doc.body?.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title: article?.title?.trim() || title, text };
  },
};

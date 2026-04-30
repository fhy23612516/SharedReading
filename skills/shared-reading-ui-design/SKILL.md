---
name: shared-reading-ui-design
description: Design and improve SharedReading UI. Use this skill whenever Codex changes the homepage, bookshelf, search, import page, reader page, comments, chat, mobile layout, styles.css, app.js markup, or any visual/UX behavior in the SharedReading novel/co-reading product; it enforces a distinct reading-app aesthetic instead of generic AI-looking UI.
---

# Shared Reading UI Design

## Design Thesis First

Before changing UI, write these three short notes in analysis or implementation notes:

1. Visual thesis: mood, material, and hierarchy.
2. Content plan: what the page must help the user do first, second, and third.
3. Interaction thesis: the 1-3 interactions or motions that matter.

Do not start by adding more cards. Start by deciding the primary reading or book-discovery surface.

## Product Identity

SharedReading is not a generic dashboard. It is a warm, social reading product with:

- Novel-reader depth.
- Bookstore and bookshelf navigation.
- Co-reading status, chat, comments, and progress as secondary context.
- Mobile-first reading comfort.

The UI should feel closer to a polished fiction reading app than a SaaS admin page.

## Required Page Patterns

### Home / Bookstore

- Use a clear top navigation: search, bookshelf, history, import, account.
- Give search a primary position.
- Show books as cover + title + author + progress/status, not equal-height generic cards.
- Keep copy short and product-facing; avoid design commentary in the UI.
- Use section hierarchy: continue reading, bookshelf/search, public-domain classics, recent co-reading.

### Reader Page

- The article text is the primary workspace.
- Center the reading column and optimize width, line length, font size, line height, and theme.
- Keep progress, settings, comments, dynamic summary, and chat secondary.
- On mobile, show text first. Move panels below text or into future drawers/tabs.
- Paragraph comments must not obscure text.

### Search / Bookshelf / History

- Search results should scan like a fiction site: cover, title, author, summary, reading progress, action.
- Bookshelf should prioritize continue reading and remove visual clutter.
- History should emphasize last-read time and progress.

### Import Page

- Import is a utility workflow, not a marketing page.
- Put title, author/source, tags, TXT picker, text area, summary, and submit in a calm form.
- Do not use backticks in template-string text inside `app.js` UI literals.

## Visual Rules

- Prefer composition over component count.
- Use at most two type families: one serif for reading/brand, one sans for utility UI.
- Use one main accent color unless state demands otherwise.
- Avoid purple defaults, heavy gradients behind routine UI, and dashboard-card mosaics.
- Use borders and shadows sparingly; if a panel can be plain layout without losing meaning, remove card styling.
- Make the first viewport understandable in seconds.
- Keep touch targets comfortable on mobile.

## CSS Rules

- Keep design tokens in `:root`.
- Avoid one-off inline styles unless the surrounding file already uses them and the change is small.
- Prefer reusable classes in `styles.css`.
- Check mobile breakpoints after every layout change.
- Avoid fixed heights for reading content on mobile unless there is a clear reason.

## Update Workflow

1. Read `skills/shared-reading-maintainer/SKILL.md` first for version/documentation requirements.
2. Inspect `app.js` markup and `styles.css` before editing.
3. Update `版本记录.md` for every UI update.
4. If the UI change affects product behavior, update `需求文档.md`.
5. Run `node --check app.js`.
6. Run `npm.cmd test` if route behavior, data rendering, or tests changed.
7. Run `git diff --check`.

## Current Design Direction

Use this as the baseline unless the user asks for a different direction:

- Theme: warm literary paper, not dark SaaS.
- Structure: bookstore front door + focused reader.
- Reading page: text-first, side panels second.
- Mobile: reading first, tools after reading.
- Public-domain classics and imported books should look like books, not task cards.

## References

This project skill is adapted from the principles of:

- OpenAI `frontend-skill`: composition, visual thesis, hierarchy, restraint, and avoiding generic card-heavy UI.
- Anthropic `frontend-design`: bold aesthetic direction and avoiding low-effort AI-looking layouts.
- Ilm-Alan `frontend-design`: explicit aesthetic anchors and CSS-token-driven visual systems.

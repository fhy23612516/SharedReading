---
name: frontier-ui-design
description: Create distinctive, production-grade frontend UI. Use this skill whenever Codex designs, redesigns, beautifies, or implements landing pages, websites, app screens, dashboards, prototypes, components, HTML/CSS layouts, React/Vue UI, or any visual frontend; it enforces strong art direction, hierarchy, typography, motion, and anti-generic-AI design quality.
---

# Frontier UI Design

## Purpose

Use this skill to produce UI that feels deliberately art-directed, current, memorable, and production-grade. Do not inherit a mediocre existing visual direction unless the user explicitly asks to preserve it.

This skill combines two complementary standards:

- OpenAI-style composition discipline: hierarchy, restraint, image-led structure, short copy, tasteful motion, and no unnecessary card clutter.
- Anthropic-style aesthetic commitment: bold direction, distinctive typography, cohesive color, unexpected composition, atmospheric detail, and no generic AI-looking defaults.

## Pre-Design Contract

Before coding, define these five points:

1. **Purpose**: What does the interface help the user do?
2. **Audience**: Who uses it and what should they feel?
3. **Visual thesis**: One sentence describing mood, material, energy, and hierarchy.
4. **Content plan**: The page/screen order and the job of each section.
5. **Interaction thesis**: Two or three motions or interactions that materially improve the feel.

If the design does not have a clear thesis, stop and create one before editing UI.

## Choose A Direction

Pick a clear aesthetic anchor. Commit to it with precision instead of making a neutral compromise.

Useful anchors:

- Editorial / magazine
- Luxury / refined
- Brutalist / raw
- Industrial / utilitarian
- Organic / natural
- Retro-futuristic
- Playful / toy-like
- Art deco / geometric
- Soft pastel / gentle
- Maximalist chaos
- Brutally minimal

Bold maximalism and refined minimalism can both work. The failure mode is not intensity; it is indecision.

## Hard Rules

- No generic SaaS card grid as the first impression.
- No hero card by default.
- No more than one dominant idea per section.
- No section should require many tiny UI devices to explain itself.
- No filler copy or design commentary in the UI.
- No predictable purple-gradient-on-white default.
- No generic font stack as the chosen aesthetic. Avoid Inter, Roboto, Arial, and plain system fonts unless preserving an existing design system.
- No stacked cards when layout, typography, spacing, lists, dividers, media blocks, or plain sections would communicate better.
- No ornamental icons, gradients, shadows, or animations that do not improve scanning, hierarchy, or atmosphere.
- No repeated aesthetic across unrelated outputs. Vary theme, typography, color, and composition to fit context.

## Composition Rules

Start with composition, not components.

- Make the first viewport feel like a poster or a purposeful product surface.
- Use scale, alignment, whitespace, cropping, contrast, and rhythm before adding chrome.
- Use a full-bleed hero or dominant visual plane for marketing/editorial pages when appropriate.
- For product/app UI, start with the primary workspace, not a marketing hero.
- Cards are allowed only when the card itself is the interaction or content unit.
- If a panel can become plain layout without losing meaning, remove the panel styling.
- Every section must have one job: orient, prove, deepen, operate, decide, or convert.

## Typography

Typography must carry personality.

- Use at most two type families unless there is a strong reason.
- Pair a distinctive display face with a refined body face when possible.
- Use type scale, weight, letter spacing, and line length intentionally.
- Make the brand/product name unmistakable in the first screen for branded pages.
- Keep headlines to roughly two or three desktop lines and readable at a glance on mobile.
- For app surfaces, labels and headings should be operational and immediately scannable.

## Color And Materials

Commit to a cohesive palette.

- Use CSS variables for design tokens.
- Prefer one dominant accent color; add secondary colors only for meaningful states.
- Strong dominant colors with sharp accents are usually better than timid evenly distributed palettes.
- Build atmosphere with contextual materials: paper, glass, ink, metal, grain, canvas, neon, clay, fabric, light, shadow, or depth.
- Backgrounds should support the thesis: image, texture, gradient mesh, noise, geometric pattern, layered transparency, or a deliberate flat field.

## Imagery And Visual Anchors

Imagery must do narrative work.

- Use real-looking, context-relevant imagery for brands, venues, products, lifestyle, editorial, or immersive pages.
- Prefer one strong visual anchor over collages.
- Choose/crop imagery with stable tonal areas for text.
- Avoid images with embedded signage, logos, or typographic clutter fighting the UI.
- If the first viewport still works after removing the image, the image was not strong enough.

If imagery is unavailable, create a non-image visual anchor through typography, layout, illustration-like CSS shapes, texture, or motion.

## Motion

Use motion to create presence and hierarchy, not noise.

For visually led work, include two or three intentional motion moments:

- One entrance sequence.
- One scroll-linked, sticky, depth, or reveal effect.
- One hover, drawer, modal, menu, or layout transition that sharpens affordance.

Motion must be fast, restrained, mobile-smooth, and consistent. Remove it if it is merely decorative.

## Copy

Write product language, not prompt language.

- Headlines carry meaning.
- Supporting copy should usually be one short sentence.
- Cut repetition aggressively.
- For app/product surfaces, prioritize orientation, status, freshness, scope, and action.
- If a sentence could appear in a generic homepage ad, rewrite it until it is specific.

## Implementation Standards

- Implement working code, not a static mock if the task asks for a functional UI.
- Respect the existing framework and architecture unless the user asks for a rewrite.
- Preserve an existing design system when present, but elevate within its constraints.
- Use reusable classes and design tokens instead of ad-hoc inline style.
- Make responsive behavior explicit.
- Maintain accessible contrast, readable text, keyboard/touch affordances, and clear focus states.
- Test mobile first viewport and a normal desktop viewport.

## UI Type Guidance

### Landing / Marketing

Default sequence:

1. Hero: brand/product, promise, action, one dominant visual.
2. Support: one concrete feature, offer, or proof point.
3. Detail: workflow, atmosphere, depth, or story.
4. Final action.

Do not use logo clouds, stat strips, pill soup, floating dashboard cards, or hero cards by default.

### App / Dashboard / Product Surface

Default structure:

1. Primary workspace.
2. Navigation.
3. Secondary context or inspector.
4. One clear action or state accent.

Avoid aspirational hero banners on operational screens unless explicitly requested.

### Content / Reading / Editorial

Default structure:

1. Text/media readability first.
2. Strong typographic hierarchy.
3. Secondary tools in sidebars, drawers, or quiet controls.
4. Mobile puts the content before controls.

## Review Checklist

Before finalizing, check:

- Is the aesthetic direction obvious in five seconds?
- Is there one strong visual anchor?
- Can the screen be understood by scanning headings, labels, and primary actions?
- Does each section have one job?
- Are cards actually necessary?
- Are fonts, colors, spacing, and motion specific to this context?
- Would the design still feel premium if decorative shadows were removed?
- Does mobile preserve the primary task?
- Did you avoid generic AI aesthetics?

## Failure Patterns To Reject

- Samey rounded cards on a pale background.
- Purple gradient hero with generic product copy.
- Dashboard-card mosaic as a landing page.
- Weak brand presence behind a large headline.
- Busy image behind unreadable text.
- Beautiful surface with unclear action.
- Motion that is invisible, noisy, or unrelated to hierarchy.
- Design that could belong to any product after changing the logo.

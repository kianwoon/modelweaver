# Apple Intelligence Window Glow — Design Spec

## Concept & Vision

A luminous, animated border wraps the ModelWeaver app window when requests are in flight. Inspired by Apple Intelligence's orbiting gradient glow — but kept minimal and performant. The effect signals "alive and processing" without drawing attention away from the data. When idle, the glow gracefully disappears.

## Design Language

- **Aesthetic**: Apple Intelligence — soft, orbiting gradient light. Premium but understated.
- **Colors**: Gradient spectrum — `purple (#9b59b6)` → `indigo (#6366f1)` → `blue (#3b82f6)` → `cyan (#06b6d4)`. Feels modern, tech-forward.
- **Intensity**: Max ~55–60% opacity. Visible but never dominant.
- **Motion**: Steady 4s linear rotation (constant pace = minimal CPU). Paused via `animation-play-state` when idle.

## Technical Approach

### Mechanism
- `::before` pseudo-element on `#app`, absolutely positioned to cover the entire viewport
- `border-radius: 10px` to match the window's rounded corners
- `background: conic-gradient(...)` with 4 color stops at 0%, 33%, 66%, 100%
- `mask-image` composition to mask out the center — keep only a 3px border ring
- `will-change: --glow-angle` so the browser promotes it to its own GPU layer
- `pointer-events: none` so it never intercepts clicks

### CSS Houdini Optimization
Register `--glow-angle` as a typed CSS property via `@property`. The browser animates it directly on the GPU without serializing the value each frame — significantly cheaper than animating `transform: rotate()`.

### Class-Driven State
- `.glow-active` on `#app` → activates the animation
- JS adds class when first request `start` event fires
- JS removes class when all active requests complete (`complete`/`error` events drain the set)
- Graceful fallback: if `conic-gradient` isn't supported, glow degrades to a static colored border

## Interaction Details

- **Request starts** → `.glow-active` added, animation begins immediately
- **Multiple concurrent requests** → class stays on (no stacking issue)
- **All requests finish** → class removed, opacity fades to 0 over 600ms
- **New request arrives during fade-out** → class re-added, opacity snaps back to full immediately

## Performance Constraints

- No JS on the hot path — zero JS timers for animation
- No `box-shadow` blur (expensive) — instead, a thin gradient border ring via `mask-image` composition
- Fallback: on reduced-motion preference, glow is disabled entirely via `@media (prefers-reduced-motion)`

## Component Changes

| File | Change |
|------|--------|
| `gui/frontend/styles.css` | Add `.glow-active`, `::before` pseudo-element, `@property`, keyframes |
| `gui/frontend/app.js` | Add `glowActiveCount` counter, increment on `start`, decrement on `complete`/`error`, toggle class |

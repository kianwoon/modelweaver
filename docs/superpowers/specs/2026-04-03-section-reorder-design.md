# Spec: Section Reorder via Drag-and-Drop

**Date:** 2026-04-03
**Status:** Approved

## Overview

Allow users to reorder the three GUI sections (Active Models, Providers, Recent) by dragging section headers. Order persists across sessions via localStorage.

---

## Design Decisions

| Decision | Choice |
|----------|--------|
| Drag handle | Grip icon (⠿) on section header, visible on hover |
| Pattern | Notion/Linear style — handle appears left of title on hover |
| Persistence | localStorage key `sectionOrder` — array of section IDs |
| Reset | Right-click context menu → "Reset order" |

---

## Layout

Three `<section class="section">` siblings in `#app` flex column:

```
#app (flex-direction: column)
  ├── <section id="models-section">
  ├── <section id="providers-section">
  └── <section id="recent-section">
```

Drag reorder applies CSS `order` property via inline `style` attribute or class toggle.

---

## HTML Changes

### Section titles — add grip handle + IDs

```html
<!-- Before -->
<section class="section">
  <h3 class="section-title">Active Models</h3>
  ...
</section>

<!-- After -->
<section class="section" id="models-section" draggable="true">
  <h3 class="section-title">
    <span class="drag-handle" title="Drag to reorder">⠿</span>
    Active Models
  </h3>
  ...
</section>
```

IDs added to all three sections:
- Active Models → `id="models-section"`
- Providers → `id="providers-section"`
- Recent → `id="recent-section"`

### Reset menu item (hidden by default)

```html
<div id="section-context-menu" class="context-menu hidden">
  <button id="reset-section-order">Reset order to default</button>
</div>
```

---

## CSS Changes

### Drag handle (gui/frontend/styles.css)

```css
/* Hidden by default, visible on section hover */
.drag-handle {
  opacity: 0;
  cursor: grab;
  font-size: 14px;
  color: var(--text-dim);
  transition: opacity 0.15s ease;
  user-select: none;
  flex-shrink: 0;
}

.section:hover .drag-handle {
  opacity: 1;
}

.drag-handle:active {
  cursor: grabbing;
}

/* Dragging state — dim the dragged section */
.section.dragging {
  opacity: 0.4;
  outline: 2px dashed var(--border-active, #4a4a6a);
  outline-offset: 2px;
}

/* Drop indicator — horizontal line between sections */
.section.drag-over-top::before {
  content: '';
  display: block;
  height: 2px;
  background: #6366f1;
  margin-bottom: -1px;
  border-radius: 1px;
}

.section.drag-over-bottom::after {
  content: '';
  display: block;
  height: 2px;
  background: #6366f1;
  margin-top: -1px;
  border-radius: 1px;
}
```

### Context menu

```css
.context-menu {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  min-width: 160px;
}

.context-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  font-size: 12px;
  background: none;
  border: none;
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
}

.context-menu button:hover {
  background: var(--border);
}
```

---

## JavaScript Changes (gui/frontend/app.js)

### 1. Default order constant

```javascript
const DEFAULT_SECTION_ORDER = ['models-section', 'providers-section', 'recent-section'];
const STORAGE_KEY = 'sectionOrder';
```

### 2. Load and apply order on init

```javascript
function initSectionOrder() {
  let order = DEFAULT_SECTION_ORDER;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) order = JSON.parse(saved);
  } catch (e) {}

  applySectionOrder(order);
}
```

### 3. applySectionOrder — set CSS order on each section

```javascript
function applySectionOrder(order) {
  const app = document.getElementById('app');
  order.forEach((sectionId, index) => {
    const section = document.getElementById(sectionId);
    if (section) {
      section.style.order = index;
    }
  });
}
```

### 4. Drag-and-drop handlers

```javascript
let draggedSection = null;
let draggedIndex = -1;

function initSectionDragDrop() {
  document.querySelectorAll('.section[draggable="true"]').forEach(section => {
    section.addEventListener('dragstart', onDragStart);
    section.addEventListener('dragend', onDragEnd);
    section.addEventListener('dragover', onDragOver);
    section.addEventListener('dragleave', onDragLeave);
    section.addEventListener('drop', onDrop);
    section.addEventListener('contextmenu', onSectionContextMenu);
  });
}

function onDragStart(e) {
  draggedSection = this;
  draggedIndex = [...this.parentNode.children].indexOf(this);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.id);
}

function onDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.section').forEach(s => {
    s.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  draggedSection = null;
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const rect = this.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  this.classList.remove('drag-over-top', 'drag-over-bottom');
  this.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
}

function onDragLeave(e) {
  this.classList.remove('drag-over-top', 'drag-over-bottom');
}

function onDrop(e) {
  e.preventDefault();
  if (this === draggedSection) return;

  const rect = this.getBoundingClientRect();
  const insertBefore = e.clientY < rect.top + rect.height / 2;

  // Reorder DOM
  const parent = this.parentNode;
  const thisIndex = [...parent.children].indexOf(this);
  const targetIndex = insertBefore ? thisIndex : thisIndex + 1;
  const finalIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;

  // Get current order from DOM (since CSS order is applied)
  const currentOrder = getCurrentSectionOrder();
  const [moved] = currentOrder.splice(draggedIndex, 1);
  currentOrder.splice(finalIndex > draggedIndex ? finalIndex - 1 : finalIndex, 0, moved);

  applySectionOrder(currentOrder);
  saveSectionOrder(currentOrder);
}
```

### 5. Persistence

```javascript
function saveSectionOrder(order) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch (e) {}
}
```

### 6. Context menu for reset

```javascript
function onSectionContextMenu(e) {
  e.preventDefault();
  const menu = document.getElementById('section-context-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.remove('hidden');

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.classList.add('hidden');
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

document.getElementById('reset-section-order').addEventListener('click', () => {
  applySectionOrder(DEFAULT_SECTION_ORDER);
  saveSectionOrder(DEFAULT_SECTION_ORDER);
  document.getElementById('section-context-menu').classList.add('hidden');
});
```

### 7. Call init on DOMContentLoaded

Add `initSectionDragDrop()` call after DOM is ready.

---

## File Changes Summary

| File | Changes |
|------|---------|
| `gui/frontend/index.html` | Add IDs to sections, `draggable="true"`, grip icon in titles, context menu HTML |
| `gui/frontend/styles.css` | `.drag-handle` styles, `.dragging` state, `.drag-over-top/bottom` indicators, context menu styles |
| `gui/frontend/app.js` | Drag-and-drop logic, order persistence, init calls |

---

## Testing Checklist

- [ ] Dragging a section visually reorders it
- [ ] Order persists after page reload
- [ ] Reset order restores default (Active Models → Providers → Recent)
- [ ] Right-click context menu appears only on section header area
- [ ] Compact mode still works (hides Providers + Recent)
- [ ] No console errors during drag operations

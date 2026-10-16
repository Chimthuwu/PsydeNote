# FIX SPECIFICATION: Unified Mega ARP & Sequencer Layout
**Target File:** `MEGA_ARP_DESIGN.png` (You must match this layout exactly)
**Status:** URGENT FIX REQUIRED. Previous implementation failed layout and broke functionality.

## 1. BROKEN FEATURE FIX (Critical)
*   **Scale Weights Toggle is Broken:** You must re-implement the event listener for the "Scale weights" text/button. When clicked, it must set a state variable `isScaleWeightsOpen = true`.
*   **Mods Container Collapse:** When `isScaleWeightsOpen` is true, the MODS container at the bottom must immediately set its CSS to `display: none` (or collapsed height). 
*   **Auto-Hide:** When the user finishes interacting with the Scale Weights overlay (e.g., on blur, mouseup, or pressing Enter), set `isScaleWeightsOpen = false`. The overlay must hide, and the MODS container must return to `display: flex` (or its original state).

## 2. LAYOUT RESTRUCTURE (Fix the "Dog Shit" Pattern Grid)
The previous implementation put the pattern buttons in a single horizontal row. **This is wrong.** You must rewrite the HTML/CSS for the middle section using strict CSS Grid.

*   **Middle Section Structure:** Create a parent flex container that holds two children side-by-side.
    *   Child 1 (Left 75% width): Pattern Grid
    *   Child 2 (Right 25% width): Chaos Knob
*   **Pattern Grid CSS:** 
    *   Set `display: grid;`
    *   Set `grid-template-columns: repeat(4, 1fr);` (or `repeat(3, 1fr)` depending on total buttons, but force a multi-row grid).
    *   Set `gap: 10px;`
    *   Each pattern button must have a minimum height of `60px` and a minimum width of `80px`.
    *   The icons inside the buttons must be scaled up to at least `32x32px`. Do not use tiny SVG icons.
*   **Chaos Knob:** You completely deleted the Chaos Knob. Re-add it to Child 2 of the middle section. It must have the proportional rainbow fill logic (0% = empty, 50% = half circle, 100% = full circle).

## 3. TIMING AND FEEL SECTION
*   Move the top controls (Direction, Length, Reset After, Swing, Sync, Transpose, Velocity %, Auto-Regen) into a tighter CSS grid or flexbox.
*   Absorb the empty space above this section to make the step lanes (On, Prob, Pitch, etc.) taller and easier to read.

## 4. GENERAL RULES
*   **NO SCROLLBARS:** The entire UI must fit within `100vh` (100% viewport height). Use `flex-grow` and `flex-shrink` to compress elements rather than allowing a scroll wheel.
*   **Visual Density:** Reduce padding and margins globally. The UI is too spread out. 
*   **Do not ask clarifying questions.** Rewrite the HTML/CSS/JS for the middle section and the Mods/Scale Weights state logic immediately based on these exact specifications.
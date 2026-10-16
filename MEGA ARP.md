# SPECIFICATION: Unified Mega ARP & Sequencer Design
**Target File:** `MEGA_ARP_DESIGN.png` (Refer to this mockup for exact layout)
**Status:** Finalized Design - Ready for Implementation

## 1. Core Architecture & High-Level Goal
*   **Merge Interfaces:** Eliminate the separate ARP and SEQ detailed views. Archive the old standalone ARP detailed view. 
*   **Unified View:** Migrate all ARP features into the SEQUENCER detailed view. The new SEQUENCER acts as the single, unified control surface.
*   **Scroll Elimination:** The unified view must fit within a single viewport without requiring vertical scrolling. Use dense CSS Grid/Flexbox layouts to achieve this.

## 2. Layout & Visual Requirements (Based on Mockup)
*   **Pattern Grid:** Implement the 12-button ARP pattern grid (Up, Down, Up/Down, As Played, Converge Up/Down, etc.) directly below the step lanes. Double the size of the pattern icons compared to the previous mockup. Active pattern must have clear visual highlighting (e.g., "Converge Down" in the mockup).
*   **Step Lanes:** Retain the existing colored step lane system (On, Prob, Pitch, Oct, Vel, Gate, Slide) with their respective color codings and step values.
*   **Chaos Knob:** Position the Chaos knob prominently on the right side. It must feature a proportional rainbow color fill representing its value (0% = no fill, 50% = half circumference fill, 100% = full circumference fill).
*   **Timing & Feel Section:** Reorganize the top controls (Direction, Length, Reset After, Swing, Sync, Transpose) to use less vertical space. Move these controls upward and absorb the empty space previously occupied by the tight/release/hold/off buttons.
*   **Mods Container:** Condense the bottom section (ENV, Audio Follower, LFO) into a single, compact horizontal strip to maximize space for the sequencer lanes.

## 3. Interaction & State Logic (CRITICAL)
*   **Scale Weights Overlay:** 
    *   When the "Scale Weights" view is triggered, it must display as a temporary overlay *directly over the PATTERN area*.
    *   **Auto-Collapse:** While the Scale Weights overlay is active, the MODS container must automatically collapse (`display: none` or collapsed state).
    *   **Auto-Hide:** When the user completes their Scale Weights edits (e.g., clicks away, releases mouse, or presses Enter), the overlay must automatically hide/revert to its hidden state. Do not require an explicit close button.
    *   Once hidden, the MODS container should expand back to its original state.
*   **Dice Controls (Probability/Faders):**
    *   Replace the separate `+` and `-` buttons with a single toggle button that lights up depending on the state (`-`, `+`, or `-+`).
    *   The Dice controls must act as draggable faders. On hover, the cursor should change to indicate dragging capability. Click and drag up/down to increase/decrease the percentage.
    *   The visual brightness/color of the dice must indicate the current value. A tooltip must display the exact percentage on hover/drag.
*   **Layers Access:** Reposition layer access controls to eliminate any need for scroll wheels or nested scrollbars.

## 4. Implementation Notes
*   **CSS:** Use CSS Grid for the step lanes to ensure perfect alignment. Use absolute positioning or a CSS overlay class for the Scale Weights view.
*   **JS/State:** Implement a state machine for the SEQUENCER view. 
    *   State: `SEQ_DEFAULT` (Mods expanded, Pattern visible)
    *   State: `SEQ_SCALE_WEIGHTS_EDIT` (Mods collapsed, Scale Weights overlay visible over Pattern)
    *   Trigger state transitions based on user interaction with the Scale Weights panel.
*   **Fader Logic:** Use pointer events (`pointerdown`, `pointermove`, `pointerup`) for the Dice fader drag behavior rather than click events.

## 5. Deliverable
Do not ask clarifying questions. Generate the HTML/CSS/JS code for this unified SEQUENCER view based on the specifications above and the `MEGA_ARP_DESIGN.png` mockup.
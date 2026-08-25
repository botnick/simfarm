// The stage the whole game is laid out in. These live apart from main.js so that
// modules main.js imports can use them without an import cycle.

// The original SWF's stage. Every coordinate recovered from it — tiles, buttons,
// HUD panels — is in this space, so the game is built in it and scaled to fit.
export const WIDTH = 600
export const HEIGHT = 420

// The art is all vector, so the game renders on a canvas twice the stage size
// and text is drawn at double size and scaled back. Nothing else has to know:
// positions stay in stage coordinates while everything stays sharp on a big
// screen.
export const RENDER_SCALE = 2

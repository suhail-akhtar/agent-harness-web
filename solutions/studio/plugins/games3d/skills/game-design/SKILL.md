---
name: game-design
description: Designing games that can be built and proven - the GDD template (pitch, core loop, controls, mechanics, rules, levels, art, audio, UI, balancing, scope), core loops and genres in 2D, 2.5D and 3D, numbers for feel and difficulty, and the goal a bot can see. Use when writing or reviewing a game design document or tuning a game.
---
# Game design

## The GDD template (design/GDD.md)

Every section is a heading; the studio-project gate checks Pitch, Core loop, Controls, Rules and Scope.

```markdown
# <Title>

## Pitch
One sentence: who you are, what you do, why it is fun. ("A fox thief hops rooftop to rooftop at night, grabbing every coin before the guard's lantern finds her.")

## Core loop
- Seconds: run, jump, grab (the verb that feels good on its own).
- Minutes: clear a level: every coin, then the exit.
- Session: three levels, each teaching one new thing.

## Controls
| Action | Keys | Notes |
| Move | Arrows / WASD | |
| Jump | Space | coyote time 0.1 s, jump buffer 0.1 s |
| Pause | P / Escape | |

## Mechanics
Each mechanic with its numbers (see Balancing) and the feedback the player gets.

## Rules (win and lose)
- Win: every coin taken and the exit reached (the game reports won: window.__game.won / StudioHook "won").
- Lose: lives 0 = unlimited retries from the last checkpoint; lives N = game over at 0.
- Score: coin 10, stomp 50.

## Levels
Count, what each teaches, the generator and settings (studio_procgen platformer {length: 48, difficulty: 0.15}), the par time.

## Art direction
Palette (hex, each colour's job), scale (16 px tiles at 2x; 1 m cells in 3D), readability rules. Details in design/style-guide.md.

## Audio
Every cue and its moment (jump, coin, hit, stomp, win, UI), the music's mood and tempo.

## UI
Title, HUD (coins x/total, lives or deaths, score), pause, win, game over.

## Balancing
| Tunable | Value | Why |
| jumpHeight | 3.2 tiles | clears 3-tile walls; the solver uses it |
| runSpeed | 6 tiles/s | a 4.8-tile flat jump |

## Scope
First version: ... Later: ...

## Proof
The playtest goal in words and its state checks: [{"path": "won", "op": "==", "value": true, "when": "ever"}]; what a bot reads: player, score, targets.
```

## Core loops by genre

- **Platformer (2D, 2.5D side-scroller)**: run, jump, collect, avoid; mastery is movement. Jump height 3-4 tiles, run 5-7 tiles/s, gravity so the jump lasts 0.7-0.9 s; gaps up to 80% of the flat jump distance; coyote time and jump buffering always.
- **Top-down action**: explore, fight, loot; mastery is spacing. Player 4-6 tiles/s; enemies slower (60-80%), a chase radius of 4-6 tiles; health 3-5 with 1 s of invulnerability after a hit; telegraphed attacks.
- **Grid puzzle**: one rule per level, combined later; undo and restart always; par moves; no dead ends without a restart in one key.
- **Isometric adventure (2.5D)**: explore a map with height, find treasure, reach a goal; arrows move along the screen; height steps of one tile.
- **Third-person 3D**: run (5-7 m/s), jump (1-1.5 m), collect, escape; a camera that never fights you (a fixed heading is the simple, bot-friendly choice).
- **First-person 3D**: walk (4-5 m/s), look, find, avoid; corridors 2+ m wide; landmarks for orientation; mouse look plus keys to turn.

## Feel (juice)

Feedback on every action within one frame: a sound, a particle burst, a squash, screen shake on hits (2-6 px, 0.2 s), a number floating up on points. Anticipation before big actions, impact after.

## Difficulty and balancing

- Ramp: introduce, practice, test, twist. One new idea per level.
- Measure it: the bots' time to goal and deaths (game_playtest events), the AI player's verdicts, the level solver's move count.
- Tune in one place: the web templates read game.json "tuning" and "physics"; keep the GDD's balancing table in step.

## The goal a machine can see

A game is only proven when a player (a bot or the AI player) reaches the goal and the game says so. Expose the state: player position, score, pickups x/total, `targets` (where to head next), `won`. The bots follow targets; the AI player reads the state and the frames.

## 2D, 2.5D or 3D

- 2D: tiles and sprites, the clearest reads, the fastest to make. Web Canvas or Godot 2D.
- 2.5D: 3D depth with 2D rules - isometric (iso tiles with height) or a side-scroller with 3D layers. Web (Canvas iso, Three.js side-scroller) or Godot 3D with an orthographic camera.
- 3D: worlds in metres, models from Blender. Web Three.js for small games, Godot for a full small game, Unreal for high-end visuals.

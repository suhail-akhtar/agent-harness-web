---
name: game-playing
description: How to play a game from frames with game_play - observe, plan, act in short steps, use the game state, notice when you are stuck, avoid loops, stay within a step budget, and record what you judged. Use before playing any game as the AI player.
---
# Playing a game from frames

## The loop
1. **Observe.** `game_play start` returns the first frame (512 px wide), the state (`window.__game` for web games) and the inputs the game names. The clock is fixed: the game waits while you think.
2. **Orient once.** What am I (the player's colour/shape, `state.player`)? What is the goal (title text, HUD, `state.targets`, a door)? Which keys do what (`state.controls`, the title screen)? Menus first: Enter or Space usually starts.
3. **Plan the next target only.** "Walk right to the coin at x=225 on the low platform, then jump." Not the whole level.
4. **Act in short steps.** One step = inputs + game time: `{"action":"step","inputs":[{"key":"ArrowRight","ms":300}],"ms":300}`. 150-600 ms per step is right for most games; a jump with a run is `[{"key":"ArrowRight","ms":500},{"key":"Space","at":50}]` with `ms` 500.
5. **Check the result** against what you expected: the state's position moved the right way, a counter went up, the frame shows it. If not, change something.

## Using the state
- `player.x / y (/ z)` and `targets` tell you exactly where to go: compare them instead of guessing from pixels. In 2D, y grows downward; in a 3D game the arrows usually move on x and z.
- Events list what happened during the step (`pickup coin 3/5`, `state playing -> won`). Errors are bugs in the game: note them.
- No state (the game exposes nothing)? Judge from frames only: pick a landmark, move, see how far it shifted, then scale your next step.

## Stuck and loops
- Nothing changed for three steps: you are stuck. Try something different: the other direction, a jump, a longer hold, a combination, Enter or Escape. Never send the same failing step more than twice.
- Oscillating (left, right, left)? Commit to one way for longer.
- A platform out of reach: approach from a higher place, or take a running jump (hold the direction through the whole jump).
- Truly no way forward (every input does nothing for seconds) is a softlock: a bug. Record it with `game_play verdict` (pass false) and stop.

## Budgets
- Steps cost tokens (a frame is a few hundred). Default budget: 60 steps; ask for `frame: false` on steps where the state is enough (long walks) and look again when something should have happened.
- `frameWidth` 384 or 320 is enough for simple 2D games.

## Recording what you judged
- `game_play verdict {"claim": "the door turned green after the last coin", "pass": true}` saves the frame you saw as evidence; add `"goal": true` when the claim is the goal itself.
- `game_play check {"checks": [{"path": "coins", "op": ">=", "value": 5}]}` checks state over the whole session.
- `game_play stop` saves the recording: `game_bot {"mode":"scripted","recording": "..."}` replays it exactly, and `game_playtest {"sessions": ["<id>"]}` puts your run in a playtest report.

## Bots do the grinding
For coverage and stress, do not play for hours: `game_bot goal` proves the goal is reachable, `explore` covers the space and finds softlocks, `monkey` hammers inputs. You judge what bots cannot: clarity, feel, fun.

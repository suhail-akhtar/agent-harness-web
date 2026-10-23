---
name: unity-build-test
description: Proving a Unity 6 game works - Unity Test Framework tests (EditMode and PlayMode, asmdefs, [Test], [UnityTest], LogAssert), running them with the unity tool and reading failures, playing the game with an input timeline (frames, fps, memory, events, a Studio playtest), the AI player's step mode, and building Windows 64-bit and WebGL players with the build report. Use before calling a Unity game done.
---
# Testing, playing and building Unity games

## Tests (Unity Test Framework)

`project.create` makes two test assemblies. Each folder with an `.asmdef` is its own assembly:

```json
{
  "name": "CoinEscape.Tests.PlayMode",
  "references": ["UnityEngine.TestRunner", "UnityEditor.TestRunner", "Harness.Bridge", "CoinEscape"],
  "includePlatforms": [],
  "overrideReferences": true,
  "precompiledReferences": ["nunit.framework.dll"],
  "autoReferenced": false,
  "defineConstraints": ["UNITY_INCLUDE_TESTS"]
}
```

EditMode tests have `"includePlatforms": ["Editor"]`. To test game code, put the game code in its own assembly (`Assets/Scripts/CoinEscape.asmdef` with `"name": "CoinEscape"`) and reference it; Assembly-CSharp (scripts without an asmdef) cannot be referenced.

```csharp
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

public class LevelTests
{
    [Test]
    public void ScoreStartsAtZero() { Assert.That(new Score().Value, Is.EqualTo(0)); }

    [UnityTest]
    public IEnumerator PlayerFallsOntoTheFloor()
    {
        SceneManager.LoadScene("Level1");            // the scene must be in the build settings
        yield return null;                           // a frame: Awake/Start ran
        var player = GameObject.FindWithTag("Player");
        float y0 = player.transform.position.y;
        yield return new WaitForSeconds(1f);
        Assert.That(player.transform.position.y, Is.LessThanOrEqualTo(y0 + 0.01f));
    }

    [UnityTest]
    public IEnumerator HoldingRightMovesRight()
    {
        SceneManager.LoadScene("Level1");
        yield return null;
        var player = GameObject.FindWithTag("Player");
        float x0 = player.transform.position.x;
        Harness.Bridge.HarnessInput.SetKey("D", true);
        yield return new WaitForSeconds(0.5f);
        Harness.Bridge.HarnessInput.Reset();
        Assert.That(player.transform.position.x, Is.GreaterThan(x0));
    }
}
```

- `[UnityTest]` returns `IEnumerator` (`yield return null` waits a frame; `new WaitForSeconds(t)`; `new WaitUntil(() => cond)`). `[UnitySetUp]` / `[UnityTearDown]` for set-up that waits.
- An error logged during a test fails it; expect one with `LogAssert.Expect(LogType.Error, "message")`.
- Run: `{"action": "test"}` runs EditMode then PlayMode (`"platform": "EditMode"` for one; `"filter": "LevelTests"` for some). The result has the counts and each failure with its message and `file:line`. Under the hood: `Unity -batchmode -projectPath P -runTests -testPlatform PlayMode -testResults results.xml` (no `-quit`: the runner exits; exit 2 means failures).

## Play with inputs

```json
{"action": "play", "seconds": 12, "scene": "Assets/Scenes/Level1.unity", "goal": "collect all coins and reach the exit", "expectWin": true,
 "inputs": [
   {"t": 0, "key": "W", "press": 2.5},
   {"t": 2.5, "keys": ["D"], "duration": 1.2},
   {"t": 4, "key": "Space", "press": 0.1},
   {"t": 5, "axis": "Horizontal", "value": -1},
   {"t": 6.5, "axis": "Horizontal", "value": 0}
 ]}
```

- Keys are KeyCode names (`W`, `Space`, `LeftArrow`, `LeftShift`, `Return`, `Alpha1`); `press`/`duration` releases after that many seconds; `down`/`up` for manual control. They reach `HarnessInput` and the Input System.
- Modes: `"mode": "batch"` (headless play mode in the editor, the default without an open editor), `"editor"` (the open editor), `"player"` (a build: pass `build`, or the newest `Builds/win64`). Player mode gives the real fps.
- The result: frames (shown), metrics (`fpsAvg`, `fpsMin`, `frameMsP95`, `memoryMb`, `drawCalls`, `errors`), the state the game published (`won`, `collected`...), the events, and a Studio playtest in `.studio/playtests/<id>/report.json` (pass when `won`, fail on errors, or on no win with `expectWin`). **Look at the frames**: is the player moving, does the exit open?
- Errors logged while playing fail the run; budgets in `.studio/project.json` (fps, memory) are checked.

The AI player drives the game step by step through `plugins/engine-unity/driver.mjs` (`createDriver(host, { project, mode })`: `start`, `step({ keys, press, axes, frames })`, `observe`, `act`, `stop`); the game pauses between steps.

## Build

```json
{"action": "build", "target": "win64"}
{"action": "build", "target": "webgl"}
{"action": "package", "target": "win64"}
```

- Output: `<project>/Builds/win64/<Product>.exe` (with `<Product>_Data/`, `UnityPlayer.dll`), `Builds/webgl/` (`index.html`, `Build/`). `package` is a release build plus `Builds/<Product>-win64.zip`. Each build is recorded in `.studio/project.json` (`builds`).
- The scenes are the enabled ones in the build settings (the first is the start scene): `level.build` and `project.create` set them; pass `scenes` to choose.
- Mono is the default scripting backend. `"scriptingBackend": "IL2CPP"` needs the IL2CPP module **and Visual Studio with the "Desktop development with C++" workload** on Windows; without them, stay on Mono.
- WebGL: compression is off by default here, so the build runs from any static server (it never runs from `file://`). It needs the WebGL Build Support module.
- The report: result, size, time, and the errors per build step. Compile errors in game code show with file and line; editor-only code (`UnityEditor`) outside an `Editor` folder is the usual cause of a build that fails while the editor works.

## Gates

- **unity-project**: each project opens headless and compiles with no errors.
- **unity-tests**: EditMode and PlayMode tests pass (at least one test runs).
- **unity-build**: the Studio project builds a player for this computer.

Without an editor or a licence the gates say "not checked" (advisory) instead of failing.

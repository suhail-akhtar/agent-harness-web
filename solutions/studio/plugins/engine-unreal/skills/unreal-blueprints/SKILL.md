---
name: unreal-blueprints
description: Building Unreal Engine 5.8 Blueprints from Python - actor Blueprints with components and variables, event graphs wired node by node with the 5.8 BlueprintGraphEditor API (events, function calls, branches, variables, component overlap events, custom functions), compiling and reading errors, and the collect-and-escape kit. Use when a game needs logic and there is no C++ compiler.
---
# Blueprints from Python (5.8)

Unreal 5.8 has a real graph API in Python: `unreal.BlueprintGraphEditor` (add nodes, wire pins, events, functions, variables) and `unreal.BlueprintGraphPin`, beside `unreal.BlueprintEditorLibrary` (create, compile, variables, events) and `unreal.SubobjectDataSubsystem` (components). `harness_ue` wraps them; everything below was run on 5.8.4.

## Make a Blueprint

```python
import harness_ue as h
bp = h.create_blueprint("/Game/Gameplay/BP_Door", "Actor")          # or a class: "Character", "/Game/.../BP_X", "/Script/Module.Class"
h.add_component(bp, "Trigger", "BoxComponent", props={"box_extent": h.unreal.Vector(100, 100, 150)})
h.add_component(bp, "Mesh", "StaticMeshComponent", parent="Trigger", props={
    "static_mesh": h.mesh("cube"), "relative_scale3d": h.unreal.Vector(2, 0.2, 3),
    "collision_profile": "NoCollision", "material": "/Game/M/M_Door"})
h.add_variable(bp, "Open", "bool", False)          # int, bool, real, string, name, text, vector, rotator, object:<class>, class:<class>, array:<type>
h.compile_blueprint(bp)                             # returns errors ["Graph/Node: message"]; also applies variable defaults
```

## Wire a graph

```python
g = h.Graph(bp)                                     # the event graph; h.Graph(bp, "MyFunction") for a function graph
ov = g.component_event("Trigger", "OnComponentBeginOverlap")
pawn = g.call("/Script/Engine.GameplayStatics:GetPlayerPawn", PlayerIndex=0)
eq = g.call("/Script/Engine.KismetMathLibrary:EqualEqual_ObjectObject")
g.wire(g.pin(ov, "OtherActor", output=True), g.pin(eq, "A"))
g.wire(g.out(pawn, "ReturnValue"), g.pin(eq, "B"))
br = g.branch()
g.wire(g.out(eq, "ReturnValue"), br.find_input_pin("Condition"))
say = g.call("/Script/Engine.KismetSystemLibrary:PrintString", InString="HARNESS_EVENT door open")
setv = g.setter("Open"); g.set(setv, "Open", True)
g.then(ov, br)                                      # exec wires; a tuple names an output: (br, "then") / (br, "else")
g.then((br, "then"), setv, say)
g.check()                                           # raises if a literal never found its typed pin
errors = h.compile_blueprint(bp)
```

- Functions are paths `/Script/<Module>.<Class>:<Function>` (`KismetSystemLibrary`, `GameplayStatics`, `KismetMathLibrary`, `KismetStringLibrary`, `Actor`, `Controller`, `HUD`...), a Blueprint's own `/Game/X/BP_Y.BP_Y_C:Fn`, or a function of the Blueprint being edited by name.
- Events: `g.event("ReceiveBeginPlay")`, `"ReceiveTick"`, `"ReceiveDrawHUD"` (HUD), `"ReceiveStartTest"` (FunctionalTest); `g.custom_event("Name")`.
- Any menu node: `g.node("Utilities|FlowControl|Branch")` (category and name without spaces); arrays: `g.length(array_pin)`, `g.array_get(array_pin, index_pin)`.
- Variables: `g.get("Score")`, `g.setter("Score")`. Another Blueprint's variables: call a function of it instead (a pure getter); member reads of other classes do not survive a recompile.
- **Math nodes are wildcards** (`+`, `==`, `<` are promotable operators): wire a typed pin first; `g.set` on a wildcard waits for that wire.
- **Pure nodes run once per use**: a `+` read again after the `Set` gives the new value plus one. Read the variable again for a print.
- Impure calls (`GetAllActorsOfClass`, `GetActorOfClass`, `PrintString`, `DestroyActor`) need exec wires; `g.flow(a, b, c)` chains the ones that have exec pins and skips pure ones. `GetActorOfClass` / `GetAllActorsOfClass` type their output from the class pin (`ActorClass="/Game/X/BP_Y.BP_Y_C"`).
- Functions with inputs and outputs: `fn = h.GraphEditor.create_and_edit_function_graph(bp, "AddScore")`, `fn.add_graph_input_parameter("Amount", h.pin_type("int"), "1")`, `ret = fn.add_graph_output_parameter("Text", h.pin_type("string"))`, `fn.set_is_pure_function(True)`; the entry node is `fn.find_graph_entry_pin().get_owning_node()`.
- Overlaps fire per component (capsule and mesh): guard pickups with a flag so they count once.

## Not in the 5.8 Python API

- **UMG widget trees** cannot be edited (`WidgetTree` exposes nothing): draw HUD text with a `HUD` Blueprint's `ReceiveDrawHUD` and `HUD:DrawText`, or `PrintString` to the screen.
- Animation Blueprints' state machines, timelines' curves and Niagara graphs: use the template's own assets.

## The collect-and-escape kit

`h.coin_game_kit()` builds (and compiles) `/Game/CoinKit`: `BP_CoinGameMode` (child of the template's game mode; Score, Total, `AddScore(Amount)`, `ScoreText()`, HUD class), `BP_CoinHUD` ("Coins: n / total"), `BP_Coin` (spinning gold coin, adds 1 and destroys itself, logs `HARNESS_EVENT score n`), `BP_Exit` (green pad: with no coin left, logs `HARNESS_EVENT win`, shows YOU WIN, quits after 2 s). Read its source in `harness_ue.py` as a worked example.

## Tests as Blueprints

`h.functional_test_count("/Game/Tests/FT_CoinCount", "/Game/CoinKit/BP_Coin", 10, level="/Game/Levels/Lvl_Coins")` makes a FunctionalTest child that asserts the count and finishes, placed in the level; Automation finds it as `Project.Functional Tests.Levels.Lvl_Coins.FT_CoinCount` (`unreal test` with `filter: "Project.Functional Tests"`).

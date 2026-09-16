# Luna Eyes

Luna Eyes is Luna Unlimited's optional local Windows visual-grounding fallback. It is used when normal `desktop.read` screenshots and coordinate-based `desktop.control` are not precise enough.

## Runtime behavior

- Public MCP tool: `desktop.vision`
- Operations: `status`, `find`, `click`, `release`
- Backend: `mudler/locate-anything.cpp` CLI
- Preferred model: `locate-anything-q6_k.gguf`
- Preferred inference mode: `hybrid`
- The model is not loaded when Luna starts. Each grounding request launches the CLI on demand; the process exits after inference so GPU memory is released.
- Desktop activity is surfaced through the Luna overlay so the user can see when Luna is observing or controlling the desktop.

## Configuration

The runtime is configured with environment variables:

- `LUNA_EYES_RUNNER` - path to `locate-anything-cli.exe`
- `LUNA_EYES_MODEL_FILE` - path to the LocateAnything GGUF model
- `LUNA_EYES_MODEL` - display/model label, normally `locate-anything-q6_k`
- `LUNA_EYES_MODE` - `hybrid`, `fast`, or `slow`
- `LUNA_EYES_THREADS` - optional CPU thread count
- `LUNA_DESKTOP_OVERLAY` - enable/disable the desktop activity overlay

Model and native build artifacts are intentionally not stored in the Luna Git repository.

## Safety and lifecycle

- `status` checks runner/model availability without loading the model.
- `find` captures the selected window/desktop, runs grounding, and maps the returned box back to screen coordinates without clicking.
- `click` performs the same grounding first and then issues one bounded desktop click at the detected center.
- Screenshots used for inference are written only to the OS temporary directory and deleted in `finally`, including failure paths.
- The overlay is shown during observation/control and hidden after the operation.
- Visual grounding is a fallback: use normal desktop APIs when coordinates are already clear.

## Validation reference

On the home Windows machine with an RTX 4060 Laptop GPU (8 GB class VRAM), the Q6_K model loads successfully through CUDA. A synthetic 1000x700 image containing a target rectangle at approximately `[700,450,900,570]` was detected as `[699.00,448.70,901.00,570.50]`. The integrated Luna main path was also validated against a real PowerShell window via `desktop.vision(find)`.

## Source-of-truth rule

The Luna Unlimited `main` branch is the source of truth for Luna Eyes code. The old `feature/luna-eyes` checkout may remain on development machines as a local model/build/experiment asset directory, but new product code should be implemented in main rather than maintained as a second fork.

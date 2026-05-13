# 🧬 Character Evolver

A SillyTavern extension that updates a character card's **description** and **personality** based on what actually happened in the chat — useful when your character grew, changed habits, learned something, or evolved emotionally during a long roleplay.

## What it does

- Sends your current character card + recent chat history to the AI (using your active connection — Gemini, Claude, OpenRouter, anything)
- Asks the AI to produce an updated description and personality, grounded *only* in events from the chat
- Shows you a **before/after preview** with editable fields so you can tweak before applying
- Saves a **versioned backup** of the original character (e.g. `Maya_v1`, `Maya_v2`) as a separate character before overwriting
- Leaves `scenario` and `first_mes` untouched

## Installation

1. Open SillyTavern → **Extensions** menu (three stacked blocks icon at the top)
2. Click **Install Extension**
3. Paste this repository URL:
   ```
   https://github.com/YOUR_USERNAME/SillyTavern-CharacterEvolver
   ```
4. Click **Install for all users** (or just for you)
5. Refresh SillyTavern

## How to use

1. Open a chat with the character you want to evolve
2. Click the **🪄 wand menu** at the bottom of the chat input → **Character Evolver**
3. In the modal:
   - Pick how many recent messages to analyze (default: 50)
   - Pick which fields to update (Description / Personality)
   - Add an optional custom instruction (e.g. *"focus on emotional growth, ignore physical changes"*)
   - Decide whether to keep a backup as a separate character (recommended ✅)
4. Click **Generate Updated Card**
5. Review the before/after diff. You can **edit the right-hand column directly** before applying.
6. Click **Apply Changes** when satisfied. The original is saved as a backup, and the active character is updated.

## Tips

- **Use a strong model for analysis** — Claude Opus, Gemini 2.5 Pro, or DeepSeek V3.1 give the best results. Flash/Haiku models tend to oversimplify the character.
- **Lower temperature is better** for this task. The extension uses 0.7 by default, but if you find the updates too creative or drifting, drop it (currently hardcoded — edit `index.js` if needed).
- **The AI uses your active chat completion settings** (model, API, endpoint), so if your roleplay is on Gemini through a proxy, the update will be too.
- **For very long chats**, 50–100 messages is usually enough. The AI just needs to see the arc of change.
- **The custom instruction box is powerful** — use it to focus the analysis. Examples:
  - "Only update habits and quirks, leave the personality core untouched"
  - "Focus on the relationship dynamic with {{user}} that developed"
  - "She is older now, account for the passage of time"

## Compatibility

- Tested on SillyTavern release ≥ 1.12
- Works with Chat Completion APIs: OpenAI, Claude, Google AI Studio, OpenRouter, Custom (OpenAI-compatible) — anything that supports a standard `/chat/completions` style endpoint
- Will *not* work in pure Text Completion mode (KoboldCpp, etc.) — the extension uses chat-completion message format

## Troubleshooting

**"AI response missing required fields"**
→ The model didn't return clean JSON. Try a stronger model or simplify your custom instruction. Some models (especially smaller ones) struggle with structured output.

**"No character is currently selected"**
→ Open a chat with a character first, then run the extension.

**Backup creation fails**
→ Check the browser console (F12) for the actual error. Usually a permissions issue with the SillyTavern user account.

**Updates feel "off" or invent things that didn't happen**
→ Lower the message count (use only the most recent / most relevant messages) and add a custom instruction like *"be conservative, only reflect explicit changes from the chat"*.

## License

MIT — do whatever you want with it.

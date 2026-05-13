// Character Evolver — SillyTavern extension
// Analyzes chat history and updates character description/personality based on what happened in roleplay.
// Backup of the original character is saved as a separate character with version suffix.

import { getContext, extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getRequestHeaders,
    generateQuietPrompt,
    getCharacters,
} from '../../../../script.js';

const EXTENSION_NAME = 'SillyTavern-CharacterEvolver';
const MODULE_NAME = 'characterEvolver';

// Default settings
const defaultSettings = {
    messagesToAnalyze: 50,
    updateDescription: true,
    updatePersonality: true,
    customInstruction: '',
    backupBeforeUpdate: true,
};

// Initialize settings
function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    for (const key in defaultSettings) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
}

// ============ PROMPT BUILDING ============

function buildAnalysisPrompt(character, chatMessages, settings) {
    const fieldsToUpdate = [];
    if (settings.updateDescription) fieldsToUpdate.push('description');
    if (settings.updatePersonality) fieldsToUpdate.push('personality');

    const charName = character.name;
    const currentDescription = character.description || '';
    const currentPersonality = character.personality || '';

    // Format chat history compactly
    const formattedChat = chatMessages.map(msg => {
        const speaker = msg.is_user ? 'User' : msg.name;
        return `${speaker}: ${msg.mes}`;
    }).join('\n\n');

    const customNote = settings.customInstruction
        ? `\n\nADDITIONAL USER INSTRUCTION: ${settings.customInstruction}\n`
        : '';

    return `You are a character card analyst. Your task is to update a roleplay character's card based on what has actually happened in the chat history.

CHARACTER NAME: ${charName}

CURRENT CHARACTER DESCRIPTION:
"""
${currentDescription}
"""

CURRENT CHARACTER PERSONALITY:
"""
${currentPersonality}
"""

RECENT CHAT HISTORY (most recent events at the bottom):
"""
${formattedChat}
"""
${customNote}
INSTRUCTIONS:
1. Analyze how the character has changed, grown, or developed during the events in the chat.
2. Consider: shifts in personality, new habits, emotional growth, new relationships mentioned, physical changes (aging, appearance), new knowledge or skills acquired, changes in worldview or values.
3. ONLY include changes that are explicitly supported by events in the chat. Do NOT invent things that didn't happen.
4. Preserve the original writing style, tone, and formatting of the character card (markdown, lists, prose style — whatever the original uses).
5. Keep the same general length and structure. Don't drastically rewrite — evolve, don't rebuild.
6. If a field has no meaningful changes based on the chat, return it nearly identical to the original.

Return your response as a JSON object with this EXACT structure (no markdown code blocks, just raw JSON):

{
  "description": "the updated description text here",
  "personality": "the updated personality text here",
  "summary_of_changes": "a brief 2-4 sentence summary of what you changed and why, in the same language as the character card"
}

Fields to update in this run: ${fieldsToUpdate.join(', ')}
For fields NOT in that list, return them with the EXACT original text unchanged.

Respond with the JSON object only. No preamble, no explanations outside the JSON.`;
}

// ============ API CALL ============
// generateQuietPrompt is SillyTavern's built-in helper for making side-channel
// AI requests from extensions. It uses the user's currently active API,
// model, endpoint, and key — exactly like the main chat does — but the
// request is invisible in the chat itself (a "quiet" generation).

async function callGenerateAPI(prompt) {
    // Signature: generateQuietPrompt(quiet_prompt, quietToLoud, skipWIAN, quietImage, quietName, responseLength)
    // - quiet_prompt: the prompt text
    // - quietToLoud: false = silent (don't show in UI), true = show as if regular message
    // - skipWIAN: true = don't inject World Info / Author's Note (we want a clean analysis)
    // - quietImage: null (we're text-only)
    // - quietName: optional name override for the AI persona
    // - responseLength: max tokens
    const response = await generateQuietPrompt(prompt, false, true, null, 'CharacterAnalyst', 4096);

    if (!response || typeof response !== 'string') {
        throw new Error('Empty or invalid response from AI.');
    }

    return response.trim();
}

// ============ JSON PARSING (robust) ============

function extractJSON(text) {
    // Strip markdown code fences if model added them despite instructions
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

    // Try direct parse first
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Find first { and last } and try parsing that range
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            const sliced = cleaned.slice(firstBrace, lastBrace + 1);
            try {
                return JSON.parse(sliced);
            } catch (e2) {
                throw new Error(`Could not parse JSON. Model returned: ${text.slice(0, 500)}...`);
            }
        }
        throw new Error(`No JSON object found in response: ${text.slice(0, 500)}...`);
    }
}

// ============ CHARACTER OPERATIONS ============

async function getCurrentCharacter() {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined || charId === null) {
        throw new Error('No character is currently selected.');
    }
    return context.characters[charId];
}

async function duplicateCharacterAsBackup(character) {
    // Find next available version number to avoid collisions
    const context = getContext();
    const baseName = character.name;
    let version = 1;
    while (context.characters.some(c => c.name === `${baseName}_v${version}`)) {
        version++;
    }
    const backupName = `${baseName}_v${version}`;

    // Strategy: use the /api/characters/duplicate endpoint, which preserves
    // the avatar image and full card data. Then rename the result.
    // This is more reliable than reconstructing the card from scratch via
    // /api/characters/create, because duplicate keeps all extension data
    // (lorebook bindings, alternate greetings, character book entries, etc.)

    const dupResponse = await fetch('/api/characters/duplicate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar }),
    });

    if (!dupResponse.ok) {
        throw new Error(`Failed to duplicate character: ${dupResponse.status} ${await dupResponse.text()}`);
    }

    const dupResult = await dupResponse.json();
    const newAvatarPath = dupResult.path;

    // Reload character list so we can find the freshly duplicated character
    await getCharacters();
    const ctxAfter = getContext();
    const duplicatedChar = ctxAfter.characters.find(c => c.avatar === newAvatarPath);

    if (!duplicatedChar) {
        // Duplicate succeeded on server but we can't find it in the client list.
        // Not a fatal error — the file exists, user just needs to refresh.
        console.warn('[CharEvolver] Duplicate created but not found in character list. Manual refresh may be needed.');
        return baseName + ' - copy';
    }

    // Rename the duplicate to the versioned name
    try {
        await renameCharacter(duplicatedChar, backupName);
        return backupName;
    } catch (renameError) {
        // Rename failed but the backup itself exists — return what we have
        console.warn('[CharEvolver] Backup created but rename failed:', renameError);
        return duplicatedChar.name;
    }
}

// Helper: returns ST headers WITHOUT Content-Type, for FormData requests.
// FormData requires the browser to set Content-Type with the multipart boundary,
// which can't happen if we set it manually.
function getHeadersForFormData() {
    const headers = getRequestHeaders();
    delete headers['Content-Type'];
    delete headers['content-type'];
    return headers;
}

async function renameCharacter(character, newName) {
    const formData = new FormData();
    formData.append('avatar_url', character.avatar);
    formData.append('ch_name', newName);
    formData.append('old_avatar', character.avatar);

    // Copy all the other fields unchanged
    formData.append('description', character.description || '');
    formData.append('personality', character.personality || '');
    formData.append('scenario', character.scenario || '');
    formData.append('first_mes', character.first_mes || '');
    formData.append('mes_example', character.mes_example || '');
    formData.append('creator_notes', character.creatorcomment || character.data?.creator_notes || '');
    formData.append('tags', JSON.stringify(character.tags || []));

    const response = await fetch('/api/characters/edit', {
        method: 'POST',
        headers: getHeadersForFormData(),
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Failed to rename character: ${response.status}`);
    }
}

async function updateCharacterFields(character, newDescription, newPersonality) {
    const formData = new FormData();
    formData.append('avatar_url', character.avatar);
    formData.append('ch_name', character.name);

    formData.append('description', newDescription);
    formData.append('personality', newPersonality);
    formData.append('scenario', character.scenario || '');
    formData.append('first_mes', character.first_mes || '');
    formData.append('mes_example', character.mes_example || '');
    formData.append('creator_notes', character.creatorcomment || character.data?.creator_notes || '');
    formData.append('tags', JSON.stringify(character.tags || []));

    const response = await fetch('/api/characters/edit', {
        method: 'POST',
        headers: getHeadersForFormData(),
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Failed to update character: ${response.status}`);
    }

    // Reload character list to reflect changes
    await getCharacters();
}

// ============ UI ============

function createMainModal() {
    // Remove existing modal if any
    document.querySelector('#charEvolverModal')?.remove();

    const settings = extension_settings[MODULE_NAME];

    const modalHTML = `
    <div id="charEvolverModal" class="char-evolver-modal-overlay">
        <div class="char-evolver-modal">
            <div class="char-evolver-header">
                <h3>🧬 Character Evolver</h3>
                <button class="char-evolver-close" id="charEvolverClose">✕</button>
            </div>

            <div class="char-evolver-body" id="charEvolverBody">
                <div class="char-evolver-section">
                    <label class="char-evolver-label">
                        Messages to analyze (from the end of chat):
                        <input type="number" id="charEvolverMsgCount" min="5" max="500" value="${settings.messagesToAnalyze}">
                    </label>
                </div>

                <div class="char-evolver-section">
                    <div class="char-evolver-label">Fields to update:</div>
                    <label class="char-evolver-checkbox">
                        <input type="checkbox" id="charEvolverUpdateDesc" ${settings.updateDescription ? 'checked' : ''}>
                        Description
                    </label>
                    <label class="char-evolver-checkbox">
                        <input type="checkbox" id="charEvolverUpdatePers" ${settings.updatePersonality ? 'checked' : ''}>
                        Personality
                    </label>
                </div>

                <div class="char-evolver-section">
                    <label class="char-evolver-label">
                        Custom instruction (optional):
                        <textarea id="charEvolverCustom" rows="3" placeholder="e.g., focus on emotional growth, ignore physical changes">${settings.customInstruction}</textarea>
                    </label>
                </div>

                <div class="char-evolver-section">
                    <label class="char-evolver-checkbox">
                        <input type="checkbox" id="charEvolverBackup" ${settings.backupBeforeUpdate ? 'checked' : ''}>
                        Save backup as separate character (recommended)
                    </label>
                </div>

                <div class="char-evolver-actions">
                    <button class="char-evolver-btn char-evolver-btn-primary" id="charEvolverGenerate">
                        ✨ Generate Updated Card
                    </button>
                </div>

                <div id="charEvolverStatus" class="char-evolver-status"></div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Event handlers
    document.querySelector('#charEvolverClose').addEventListener('click', () => {
        document.querySelector('#charEvolverModal').remove();
    });

    document.querySelector('#charEvolverGenerate').addEventListener('click', handleGenerate);

    // Save settings on change
    document.querySelector('#charEvolverMsgCount').addEventListener('change', (e) => {
        settings.messagesToAnalyze = parseInt(e.target.value, 10) || 50;
        saveSettingsDebounced();
    });
    document.querySelector('#charEvolverUpdateDesc').addEventListener('change', (e) => {
        settings.updateDescription = e.target.checked;
        saveSettingsDebounced();
    });
    document.querySelector('#charEvolverUpdatePers').addEventListener('change', (e) => {
        settings.updatePersonality = e.target.checked;
        saveSettingsDebounced();
    });
    document.querySelector('#charEvolverCustom').addEventListener('change', (e) => {
        settings.customInstruction = e.target.value;
        saveSettingsDebounced();
    });
    document.querySelector('#charEvolverBackup').addEventListener('change', (e) => {
        settings.backupBeforeUpdate = e.target.checked;
        saveSettingsDebounced();
    });
}

function setStatus(text, isError = false) {
    const el = document.querySelector('#charEvolverStatus');
    if (el) {
        el.textContent = text;
        el.className = 'char-evolver-status' + (isError ? ' char-evolver-status-error' : '');
    }
}

async function handleGenerate() {
    const settings = extension_settings[MODULE_NAME];
    const btn = document.querySelector('#charEvolverGenerate');

    try {
        btn.disabled = true;
        setStatus('Collecting context...');

        const character = await getCurrentCharacter();
        const context = getContext();

        // Grab the last N messages
        const allChat = context.chat || [];
        const messagesToAnalyze = allChat.slice(-settings.messagesToAnalyze);

        if (messagesToAnalyze.length < 3) {
            throw new Error('Not enough chat history to analyze (need at least 3 messages).');
        }

        setStatus(`Sending ${messagesToAnalyze.length} messages to AI for analysis...`);

        const prompt = buildAnalysisPrompt(character, messagesToAnalyze, settings);
        const rawResponse = await callGenerateAPI(prompt);

        setStatus('Parsing response...');
        const parsed = extractJSON(rawResponse);

        if (!parsed.description || !parsed.personality) {
            throw new Error('AI response missing required fields (description / personality).');
        }

        setStatus('Done. Review the changes below.');
        showPreview(character, parsed, settings);

    } catch (error) {
        console.error('[CharEvolver] Generate failed:', error);
        setStatus('Error: ' + error.message, true);
    } finally {
        btn.disabled = false;
    }
}

function showPreview(character, updates, settings) {
    const modal = document.querySelector('#charEvolverModal .char-evolver-modal');
    const body = document.querySelector('#charEvolverBody');

    const summaryHTML = updates.summary_of_changes
        ? `<div class="char-evolver-summary"><strong>Summary of changes:</strong><br>${escapeHtml(updates.summary_of_changes)}</div>`
        : '';

    body.innerHTML = `
        ${summaryHTML}

        ${settings.updateDescription ? `
        <div class="char-evolver-diff-section">
            <h4>Description</h4>
            <div class="char-evolver-diff-cols">
                <div class="char-evolver-diff-col">
                    <div class="char-evolver-diff-label">BEFORE</div>
                    <div class="char-evolver-diff-text">${escapeHtml(character.description || '')}</div>
                </div>
                <div class="char-evolver-diff-col">
                    <div class="char-evolver-diff-label">AFTER</div>
                    <textarea class="char-evolver-diff-textarea" id="charEvolverNewDesc">${escapeHtml(updates.description)}</textarea>
                </div>
            </div>
        </div>
        ` : ''}

        ${settings.updatePersonality ? `
        <div class="char-evolver-diff-section">
            <h4>Personality</h4>
            <div class="char-evolver-diff-cols">
                <div class="char-evolver-diff-col">
                    <div class="char-evolver-diff-label">BEFORE</div>
                    <div class="char-evolver-diff-text">${escapeHtml(character.personality || '')}</div>
                </div>
                <div class="char-evolver-diff-col">
                    <div class="char-evolver-diff-label">AFTER</div>
                    <textarea class="char-evolver-diff-textarea" id="charEvolverNewPers">${escapeHtml(updates.personality)}</textarea>
                </div>
            </div>
        </div>
        ` : ''}

        <div class="char-evolver-actions">
            <button class="char-evolver-btn char-evolver-btn-secondary" id="charEvolverBack">← Back</button>
            <button class="char-evolver-btn char-evolver-btn-primary" id="charEvolverApply">✓ Apply Changes</button>
        </div>

        <div id="charEvolverStatus" class="char-evolver-status"></div>
    `;

    document.querySelector('#charEvolverBack').addEventListener('click', () => {
        createMainModal();
    });

    document.querySelector('#charEvolverApply').addEventListener('click', async () => {
        try {
            const applyBtn = document.querySelector('#charEvolverApply');
            applyBtn.disabled = true;

            // Read possibly-edited values from textareas
            const finalDescription = settings.updateDescription
                ? document.querySelector('#charEvolverNewDesc').value
                : character.description;
            const finalPersonality = settings.updatePersonality
                ? document.querySelector('#charEvolverNewPers').value
                : character.personality;

            if (settings.backupBeforeUpdate) {
                setStatus('Creating backup...');
                const backupName = await duplicateCharacterAsBackup(character);
                setStatus(`Backup saved as "${backupName}". Applying updates...`);
            } else {
                setStatus('Applying updates...');
            }

            await updateCharacterFields(character, finalDescription, finalPersonality);

            setStatus('✓ Character updated successfully! Reload the chat to see changes.');

            setTimeout(() => {
                document.querySelector('#charEvolverModal')?.remove();
            }, 2500);

        } catch (error) {
            console.error('[CharEvolver] Apply failed:', error);
            setStatus('Error: ' + error.message, true);
            document.querySelector('#charEvolverApply').disabled = false;
        }
    });
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============ ENTRY POINT — Add wand menu button ============

function addWandMenuButton() {
    const wandMenu = document.querySelector('#extensionsMenu');
    if (!wandMenu) {
        // Try again later
        setTimeout(addWandMenuButton, 1000);
        return;
    }

    if (document.querySelector('#charEvolverWandBtn')) return; // already added

    const button = document.createElement('div');
    button.id = 'charEvolverWandBtn';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.innerHTML = `
        <div class="fa-solid fa-dna extensionsMenuExtensionButton"></div>
        <span>Character Evolver</span>
    `;
    button.addEventListener('click', () => {
        createMainModal();
    });

    wandMenu.appendChild(button);
}

// ============ INIT ============

jQuery(async () => {
    loadSettings();
    addWandMenuButton();
    console.log('[CharEvolver] Extension loaded.');
});

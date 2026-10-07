// content/chatgpt.js
// Production-grade ChatGPT Content Script & DOM Adapter for PromptFlow

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__PROMPTFLOW_INJECTED__) {
    return;
  }
  window.__PROMPTFLOW_INJECTED__ = true;

  console.log('[PromptFlow] Content script initialized on:', window.location.href);

  // Ensure Main World Lexical Bridge is attached
  try {
    if (!document.getElementById('promptflow-main-bridge')) {
      const s = document.createElement('script');
      s.id = 'promptflow-main-bridge';
      s.src = chrome.runtime.getURL('content/chatgpt-main.js');
      (document.head || document.documentElement).appendChild(s);
    }
  } catch (e) {}

  // Helper delay
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Centralized ChatGPT DOM Adapter
   * Implements multi-strategy, fault-tolerant element discovery and manipulation.
   */
  class ChatGPTAdapter {
    constructor() {
      this.lastKnownComposer = null;
      this.existingImagesSnapshot = new Set();
    }

    /**
     * Checks if the user is authenticated and not on a login/landing page.
     */
    isAuthenticated() {
      // If login or signup buttons are prominently featured as primary action
      const loginButton = document.querySelector('a[href*="/login"], button[data-testid="login-button"]');
      const isAuthPage = window.location.pathname.startsWith('/auth') || window.location.pathname.startsWith('/login');
      if (isAuthPage) return false;

      // Check if composer or user profile exists
      const composer = this.findComposer();
      const userNav = document.querySelector('button[data-testid="profile-button"], [data-testid="user-menu-button"], img[alt*="User" i]');
      return !!(composer || userNav || !loginButton);
    }

    /**
     * Checks if an element is present and active in the layout tree.
     * Works reliably even when the tab is in the background or minimized.
     */
    isElementActive(el) {
      if (!el || !el.isConnected) return false;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
      } catch (e) {
        return el.offsetParent !== null || el.isConnected;
      }
    }

    /**
     * Multi-strategy composer detection.
     * ChatGPT frequently updates between textarea, contenteditable div, and role="textbox".
     */
    findComposer() {
      const strategies = [
        () => document.querySelector('#prompt-textarea'),
        () => document.querySelector('div[contenteditable="true"][id*="prompt"]'),
        () => document.querySelector('div[contenteditable="true"][data-placeholder]'),
        () => document.querySelector('div[contenteditable="true"]'),
        () => document.querySelector('textarea[data-id="root"]'),
        () => document.querySelector('textarea[placeholder*="message" i]'),
        () => document.querySelector('textarea[placeholder*="ask" i]'),
        () => document.querySelector('form textarea'),
        () => document.querySelector('[role="textbox"]')
      ];

      for (const strategy of strategies) {
        try {
          const el = strategy();
          if (this.isElementActive(el)) {
            this.lastKnownComposer = el;
            return el;
          }
        } catch (e) {
          // ignore selector errors
        }
      }

      // Check fallback if cached reference is still in DOM
      if (this.lastKnownComposer && document.body.contains(this.lastKnownComposer)) {
        return this.lastKnownComposer;
      }

      return null;
    }

    /**
     * Finds the parent form or container of the composer.
     */
    findComposerContainer() {
      const composer = this.findComposer();
      if (!composer) return null;
      return composer.closest('form') || composer.closest('fieldset') || composer.parentElement?.parentElement || null;
    }

    /**
     * Finds the Send / Submit button using semantic attributes and DOM location.
     */
    findSendButton() {
      const container = this.findComposerContainer() || document;
      const strategies = [
        () => container.querySelector('button[data-testid="send-button"]'),
        () => container.querySelector('button[aria-label*="Send prompt" i]'),
        () => container.querySelector('button[aria-label*="Send message" i]'),
        () => container.querySelector('button[aria-label*="Send" i]'),
        () => container.querySelector('button[data-testid="fruitjuice-send-button"]'),
        // Button with send arrow / SVG inside composer container
        () => {
          const buttons = container.querySelectorAll('button');
          for (const b of buttons) {
            const svg = b.querySelector('svg');
            const aria = b.getAttribute('aria-label') || '';
            if (aria.toLowerCase().includes('send') || (svg && this.isElementActive(b) && !b.disabled)) {
              return b;
            }
          }
          return null;
        }
      ];

      for (const strategy of strategies) {
        try {
          const btn = strategy();
          if (btn && this.isElementActive(btn)) return btn;
        } catch (e) {}
      }
      return null;
    }

    /**
     * Finds the Stop Generation button.
     */
    findStopButton() {
      const container = this.findComposerContainer() || document;
      const strategies = [
        () => container.querySelector('button[data-testid="stop-button"]'),
        () => container.querySelector('button[aria-label*="Stop" i]'),
        () => container.querySelector('button[data-testid="stop-generating-button"]'),
        () => document.querySelector('button[data-testid="stop-button"]'),
        () => document.querySelector('button[aria-label*="Stop" i]')
      ];

      for (const strategy of strategies) {
        try {
          const btn = strategy();
          if (btn && this.isElementActive(btn)) return btn;
        } catch (e) {}
      }
      return null;
    }

    /**
     * Detects if ChatGPT is actively generating / streaming.
     */
    isGenerating() {
      // Signal 1: Stop button is present and visible
      if (this.findStopButton()) return true;

      // Signal 2: Streaming class or attribute on conversation or body
      if (document.querySelector('.result-streaming, [data-is-streaming="true"]')) return true;

      // Signal 3: Check if send button is transformed into stop icon or disabled during streaming
      const sendBtn = this.findSendButton();
      if (sendBtn && sendBtn.getAttribute('aria-label')?.toLowerCase().includes('stop')) {
        return true;
      }

      return false;
    }

    /**
     * Finds the attachment input or attach button.
     */
    findAttachmentElements() {
      // Directly check for file inputs in the DOM
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
      let directFileInput = fileInputs.find((i) => i.accept?.includes('image') || !i.accept) || fileInputs[0] || null;

      // Check attach buttons
      const container = this.findComposerContainer() || document;
      const buttonStrategies = [
        () => container.querySelector('button[data-testid*="attach" i]'),
        () => container.querySelector('button[aria-label*="Attach" i]'),
        () => container.querySelector('button[aria-label*="Add files" i]'),
        () => container.querySelector('button[aria-label*="Upload" i]'),
        () => container.querySelector('button[data-testid="fruitjuice-attachment-button"]'),
        () => document.querySelector('button[data-testid*="attach" i]'),
        () => document.querySelector('button[aria-label*="Attach" i]')
      ];

      let attachButton = null;
      for (const strat of buttonStrategies) {
        try {
          const b = strat();
          if (b && this.isElementActive(b)) {
            attachButton = b;
            break;
          }
        } catch (e) {}
      }

      return { fileInput: directFileInput, attachButton };
    }

    /**
     * Converts a dataURL/base64 to a File object.
     */
    dataUrlToFile(dataUrl, filename = 'reference.png') {
      const arr = dataUrl.split(',');
      const mime = arr[0].match(/:(.*?);/)[1] || 'image/png';
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new File([u8arr], filename, { type: mime });
    }

    /**
     * Dismisses any modal backdrop or stuck drag-and-drop overlays in ChatGPT.
     */
    dismissStuckOverlays() {
      try {
        // 1. Dispatch dragleave to clear ChatGPT's isDragging state
        const dragLeaveEvt = new DragEvent('dragleave', { bubbles: true, cancelable: true });
        window.dispatchEvent(dragLeaveEvt);
        document.dispatchEvent(dragLeaveEvt);
        document.body.dispatchEvent(dragLeaveEvt);

        // 2. Dispatch Escape to close any modal dialog or drop backdrop
        const escDown = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
        const escUp = new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
        window.dispatchEvent(escDown);
        window.dispatchEvent(escUp);

        // 3. Hide any stuck full-screen drop overlay element without breaking React tree
        const stuckDropOverlays = document.querySelectorAll(
          '[data-testid*="drop" i], [class*="dropzone" i], [class*="overlay" i][class*="drag" i]'
        );
        stuckDropOverlays.forEach((el) => {
          if (el.textContent?.includes('Drop any file') || el.textContent?.includes('Add anything')) {
            el.style.display = 'none';
            el.style.pointerEvents = 'none';
          }
        });
      } catch (e) {
        console.warn('[PromptFlow] Error dismissing stuck overlays:', e);
      }
    }

    /**
     * Uploads the reference image via synthetic file input change.
     */
    async uploadReference(fileData) {
      console.log('[PromptFlow] Uploading reference image:', fileData.name);
      this.dismissStuckOverlays();

      // Check if reference image is already genuinely attached in composer thumbnail (strictly NOT the attach button)
      const container = this.findComposerContainer() || document;
      const existingAttachment = container.querySelector(
        '[data-testid="attachment-thumbnail"], [data-testid*="thumbnail" i], button[aria-label*="Remove" i], button[data-testid*="remove" i], img[src^="blob:"]'
      );
      if (existingAttachment && this.isElementActive(existingAttachment)) {
        const isAttachButton = existingAttachment.matches('button[data-testid*="attach" i], button[aria-label*="Attach" i], button[data-testid*="fruitjuice" i]') ||
                               existingAttachment.closest('button[data-testid*="attach" i], button[aria-label*="Attach" i], button[data-testid*="fruitjuice" i]');
        if (!isAttachButton) {
          console.log('[PromptFlow] Reference image already attached in composer, skipping redundant upload.');
          return true;
        }
      }

      const file = this.dataUrlToFile(fileData.dataUrl, fileData.name || 'reference.png');
      const dt = new DataTransfer();
      dt.items.add(file);

      let { fileInput, attachButton } = this.findAttachmentElements();

      // If file input not present in DOM, click attach button to expose it
      if (!fileInput && attachButton) {
        console.log('[PromptFlow] Clicking attach button to expose file input...');
        attachButton.click();
        await sleep(500);
        fileInput = this.findAttachmentElements().fileInput;
      }

      // Inject file directly into the file input using native property setter
      if (fileInput) {
        try {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
          if (nativeSetter) {
            nativeSetter.call(fileInput, dt.files);
          } else {
            fileInput.files = dt.files;
          }
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('[PromptFlow] Injected file into <input type="file">');
        } catch (e) {
          console.warn('[PromptFlow] Direct file input assignment warning:', e);
          try {
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e2) {}
        }
      }

      // Now wait for attachment thumbnail to appear and stabilize
      await this.waitForAttachment(20000);
      this.dismissStuckOverlays();
      console.log('[PromptFlow] Reference image upload verified successfully');
      return true;
    }

    /**
     * Waits until the uploaded image attachment thumbnail is visible in composer.
     */
    async waitForAttachment(timeoutMs = 25000) {
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const container = this.findComposerContainer() || document;

        // Look for genuine attachment preview elements (strictly exclude buttons or file upload triggers)
        const previewSelectors = [
          '[data-testid="attachment-thumbnail"]',
          '[data-testid*="thumbnail" i]',
          'button[aria-label*="Remove" i]',
          'button[aria-label*="Delete" i]',
          'button[data-testid*="remove" i]',
          'img[src^="blob:"]',
          'img[src*="attachment"]',
          '[data-testid*="file-pill"]',
          '[data-testid*="attachment-pill"]'
        ];

        let previewFound = false;
        for (const sel of previewSelectors) {
          const el = container.querySelector(sel);
          if (el && this.isElementActive(el)) {
            const isAttachButton = el.matches('button[data-testid*="attach" i], button[aria-label*="Attach" i], button[data-testid*="fruitjuice" i]') ||
                                   el.closest('button[data-testid*="attach" i], button[aria-label*="Attach" i], button[data-testid*="fruitjuice" i]');
            if (!isAttachButton) {
              previewFound = true;
              break;
            }
          }
        }

        // Check if there is an active upload progress spinner
        const spinner = container.querySelector('[role="progressbar"], .loading-spinner, [aria-label*="loading" i], [aria-label*="uploading" i]');

        if (previewFound && !spinner) {
          // Stabilization buffer: ensure ChatGPT's React state finishes binding the attachment
          await sleep(1500);
          return true;
        }

        await sleep(400);
      }

      console.warn('[PromptFlow] Attachment verification timed out, checking composer state...');
      return false;
    }

    /**
     * Resets ChatGPT to a fresh conversation in the SAME tab without reloading.
     */
    async startNewChat() {
      console.log('[PromptFlow] Starting new chat in same tab without page reload...');
      const newChatSelectors = [
        'a[href="/"]',
        'button[data-testid="create-new-chat-button"]',
        'button[aria-label*="New chat" i]',
        'a[aria-label*="New chat" i]',
        '[data-testid="new-chat-button"]',
        'a[data-discover="true"][href="/"]'
      ];

      for (const sel of newChatSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.click();
          console.log('[PromptFlow] Clicked New Chat button in same tab:', sel);
          await sleep(1200);
          return true;
        }
      }

      // Check sidebar open/toggle
      const sidebarToggle = document.querySelector('button[aria-label*="sidebar" i], [data-testid="open-sidebar-button"]');
      if (sidebarToggle) {
        sidebarToggle.click();
        await sleep(400);
        for (const sel of newChatSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            el.click();
            await sleep(1200);
            return true;
          }
        }
      }

      // Client navigation fallback without reload
      if (window.location.pathname !== '/') {
        window.history.pushState(null, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
        await sleep(1000);
      }
      return true;
    }

    /**
     * Waits until ChatGPT is completely idle (not generating, composer present).
     */
    async waitForIdle(timeoutMs = 15000) {
      this.dismissStuckOverlays();
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (!this.isGenerating()) {
          const composer = this.findComposer();
          if (composer) {
            await sleep(300);
            return true;
          }
        }
        await sleep(300);
      }
      return false;
    }

    /**
     * Inserts prompt text into ChatGPT composer using native input pipelines.
     * Works seamlessly even when tab is in background / off-screen.
     */
    async insertPrompt(text) {
      this.dismissStuckOverlays();
      // Ensure ChatGPT is not still generating from previous prompt
      await this.waitForIdle(15000);

      const composer = this.findComposer();
      if (!composer) {
        throw new Error('ChatGPT composer input could not be found');
      }

      composer.focus();
      await sleep(100);

      const isContentEditable = composer.isContentEditable || composer.getAttribute('contenteditable') === 'true';

      if (isContentEditable) {
        // Clear existing content cleanly
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(composer);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false, null);
        } catch (e) {}
        composer.innerHTML = '';
        composer.textContent = '';
        await sleep(40);

        // Native insertText
        let success = false;
        try {
          success = document.execCommand('insertText', false, text);
        } catch (e) {}

        await sleep(50);
        const currentContent = (composer.innerText || composer.textContent || '').trim();
        const snippet = text.slice(0, Math.min(20, text.length));

        // When tab is not focused / in background, execCommand is disabled by Chromium.
        // Directly inject Lexical-compliant DOM structure:
        if (!success || !currentContent || !currentContent.includes(snippet)) {
          console.log('[PromptFlow] Native insertText incomplete (background tab), applying direct Lexical DOM injection...');
          composer.innerHTML = '';
          const lines = text.split(/\r?\n/);
          lines.forEach((line) => {
            const p = document.createElement('p');
            p.setAttribute('dir', 'auto');
            if (line.length > 0) {
              const span = document.createElement('span');
              span.setAttribute('data-lexical-text', 'true');
              span.textContent = line;
              p.appendChild(span);
            } else {
              p.appendChild(document.createElement('br'));
            }
            composer.appendChild(p);
          });

          composer.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: text
            })
          );
          composer.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: text
            })
          );
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          composer.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else {
        // Standard textarea
        composer.value = text;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await sleep(250);
      console.log('[PromptFlow] Inserted prompt text into composer:', text.slice(0, 35));
      return true;
    }

    /**
     * Seamlessly inserts prompt text and submits in ONE atomic operation.
     * Uses the Main World Lexical Bridge for instant state updates in background tabs.
     */
    async insertAndSubmitPrompt(text) {
      if (this._isSubmittingPrompt) {
        console.warn('[PromptFlow] Prompt submission already in progress, skipping duplicate');
        return true;
      }
      this._isSubmittingPrompt = true;

      try {
        this.dismissStuckOverlays();

        // 1. Try Main World Lexical Bridge first (CSP-exempt, directly sets Lexical EditorState)
        const nonce = 'pf_' + Math.random().toString(36).slice(2);

        const bridgePromise = new Promise((resolve) => {
          const handler = (e) => {
            if (e.detail?.nonce === nonce) {
              window.removeEventListener('__PROMPTFLOW_MAIN_DONE__', handler);
              resolve(e.detail);
            }
          };
          window.addEventListener('__PROMPTFLOW_MAIN_DONE__', handler);
          setTimeout(() => {
            window.removeEventListener('__PROMPTFLOW_MAIN_DONE__', handler);
            resolve({ success: false, timeout: true });
          }, 4500);
        });

        window.dispatchEvent(
          new CustomEvent('__PROMPTFLOW_MAIN_SUBMIT__', {
            detail: { promptText: text, nonce }
          })
        );

        const res = await bridgePromise;
        if (res && res.success) {
          console.log('[PromptFlow] Prompt submitted via Main World Lexical Bridge!');
          await sleep(600);
          return true;
        }

        console.log('[PromptFlow] Main World Bridge note:', res?.error || 'timeout, using isolated fallback');

        // 2. Fallback: Isolated world input and single sendBtn.click()
        await this.insertPrompt(text);
        await sleep(300);
        await this.submitPrompt(true);
        return true;
      } finally {
        this._isSubmittingPrompt = false;
      }
    }

    /**
     * Submits the prompt by clicking Send or triggering Enter keydown.
     * Dispatches exactly ONE submission event to prevent duplicate prompts.
     */
    async submitPrompt(force = false) {
      if (this._isSubmittingPrompt && !force) {
        console.warn('[PromptFlow] submitPrompt is already in progress, ignoring duplicate call');
        return true;
      }
      this._isSubmittingPrompt = true;

      try {
        this.dismissStuckOverlays();

        const composer = this.findComposer();
        const currentText = (composer?.innerText || composer?.textContent || composer?.value || '').trim();
        if (!currentText) {
          throw new Error('Refusing to submit prompt: composer text is empty (prevents sending attachment alone)');
        }

        // 1. Wait briefly for Send button to become enabled (up to 3s with active input refresh)
        let sendBtn = null;
        for (let i = 0; i < 6; i++) {
          sendBtn = this.findSendButton();
          if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
            break;
          }

          // Periodic input event refresh to wake up ChatGPT Lexical state
          if (composer) {
            composer.focus();
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            composer.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await sleep(400);
        }

        if (sendBtn) {
          sendBtn.removeAttribute('disabled');
          sendBtn.setAttribute('aria-disabled', 'false');
          sendBtn.disabled = false;
          sendBtn.focus();
          // Dispatch ONLY the single native click event to prevent sending duplicate prompts
          sendBtn.click();
          console.log('[PromptFlow] Clicked Send button successfully (single dispatch)');
          await sleep(800);
          return true;
        }

        // 2. Fallback: Dispatch Enter keydown/keyup on composer ONLY if send button was not found
        if (composer) {
          console.log('[PromptFlow] Fallback: Dispatching Enter keydown on composer');
          composer.focus();
          const enterDown = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          const enterUp = new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          composer.dispatchEvent(enterDown);
          composer.dispatchEvent(enterUp);
          await sleep(800);
          return true;
        }

        throw new Error('Failed to submit prompt: Send button not clickable after waiting');
      } finally {
        this._isSubmittingPrompt = false;
      }
    }

    /**
     * Finds all assistant message elements in the conversation, strictly excluding user messages.
     */
    getAssistantMessages() {
      // Primary: Elements with assistant role
      const roleAssistant = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      if (roleAssistant.length > 0) return roleAssistant;

      // Secondary: Filter conversation articles that do NOT contain user role
      const articles = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"]'));
      const assistantArticles = articles.filter((art) => !art.querySelector('[data-message-author-role="user"]'));
      if (assistantArticles.length > 0) return assistantArticles;

      // Fallback: Check general assistant container elements
      const fallback = Array.from(document.querySelectorAll('.agent-turn, [data-message-model-slug]'));
      if (fallback.length > 0) return fallback;

      return [];
    }

    /**
     * Takes snapshot of all existing image URLs in the DOM before generation starts
     * and records baseline assistant message count to accurately distinguish identical prompts.
     */
    snapshotBeforePrompt() {
      this.existingImagesSnapshot = new Set();
      const images = document.querySelectorAll('img');
      images.forEach((img) => {
        if (img.src) this.existingImagesSnapshot.add(img.src);
        if (img.currentSrc) this.existingImagesSnapshot.add(img.currentSrc);
      });
      const assistantMsgs = this.getAssistantMessages();
      this.baselineAssistantCount = assistantMsgs.length;
      this.baselineTurnCount = this.getAssistantTurns().length;
      console.log(`[PromptFlow] Recorded snapshot of ${this.existingImagesSnapshot.size} images. Baseline assistant msgs: ${this.baselineAssistantCount}, turns: ${this.baselineTurnCount}`);
      return { count: this.existingImagesSnapshot.size, baselineAssistantCount: this.baselineAssistantCount, baselineTurns: this.baselineTurnCount };
    }

    /**
     * Waits for generation to start (stop button appearing, streaming state, or new assistant turn created).
     */
    async waitForGenerationStart(timeoutMs = 25000) {
      const startTime = Date.now();
      console.log(`[PromptFlow] Waiting for generation start signal (baseline turns: ${this.baselineTurnCount})...`);

      while (Date.now() - startTime < timeoutMs) {
        const isGen = this.isGenerating();
        const currentTurns = this.getAssistantTurns().length;
        const hasNewTurn = currentTurns > (this.baselineTurnCount || 0);

        if (isGen || hasNewTurn) {
          console.log(`[PromptFlow] Generation start detected (isGen=${isGen}, newTurn=${hasNewTurn})`);
          return true;
        }
        await sleep(350);
      }

      console.warn('[PromptFlow] Generation start signal timed out (ChatGPT may have already started)');
      return false;
    }

    /**
     * Waits for generation to complete on the NEW assistant turn.
     * Prevents previous generation from being mistaken as the current one.
     */
    async waitForGenerationComplete(timeoutMinutes = 5) {
      const timeoutMs = timeoutMinutes * 60 * 1000;
      const startTime = Date.now();
      console.log(`[PromptFlow] Waiting for generation completion on new turn (max ${timeoutMinutes} mins)...`);

      // Initial sleep to allow ChatGPT to receive prompt
      await sleep(1500);

      let stabilizedCount = 0;
      const STABILIZED_TARGET = 3;

      while (Date.now() - startTime < timeoutMs) {
        const currentTurns = this.getAssistantTurns().length;
        const hasNewTurn = currentTurns > (this.baselineTurnCount || 0);
        const generating = this.isGenerating();

        // Must have created a new assistant turn AND stopped generating
        if (hasNewTurn && !generating) {
          stabilizedCount++;
          if (stabilizedCount >= STABILIZED_TARGET) {
            console.log(`[PromptFlow] Generation completion verified on new turn (${currentTurns} > ${this.baselineTurnCount})`);
            return true;
          }
        } else {
          stabilizedCount = 0;
        }

        await sleep(1000);
      }

      throw new Error(`Generation timed out after ${timeoutMinutes} minutes`);
    }

    /**
     * Finds all assistant conversation turns.
     */
    getAssistantTurns() {
      const turns = Array.from(
        document.querySelectorAll(
          'article[data-testid^="conversation-turn-"], div[data-message-author-role="assistant"], [data-message-model-slug]'
        )
      );

      if (turns.length > 0) return turns;

      // Fallback: look for articles or conversation container items
      const generalArticles = Array.from(document.querySelectorAll('article'));
      if (generalArticles.length > 0) return generalArticles;

      return [];
    }

    /**
     * Checks if an image is a UI element, icon, or avatar rather than a generated image.
     */
    isAvatarOrUIElement(img) {
      if (!img) return true;
      const src = img.currentSrc || img.src || '';
      const alt = (img.getAttribute('alt') || '').toLowerCase().trim();
      const className = (img.className || '').toLowerCase();
      const parentClass = (img.parentElement?.className || '').toLowerCase();

      // Definitive generated image signals
      if (
        src.includes('oaiusercontent.com') ||
        src.includes('backend-api/files') ||
        src.includes('oaistorage') ||
        alt.includes('generated') ||
        alt.includes('dall-e') ||
        alt.includes('dall·e') ||
        alt.includes('dalle')
      ) {
        return false;
      }

      // Definitive avatar / UI signals
      if (
        img.closest('button[data-testid="profile-button"]') ||
        img.closest('[data-testid="user-menu-button"]') ||
        src.includes('avatar') ||
        src.includes('gravatar') ||
        src.includes('googleusercontent.com/a/') ||
        className.includes('avatar') ||
        parentClass.includes('avatar') ||
        alt === 'user' ||
        alt === 'avatar' ||
        alt === 'chatgpt' ||
        alt === 'profile' ||
        alt === 'user avatar' ||
        alt === 'chatgpt avatar'
      ) {
        return true;
      }

      // Small icons
      if (img.naturalWidth > 0 && img.naturalWidth <= 64) return true;
      if (img.naturalHeight > 0 && img.naturalHeight <= 64) return true;
      if (img.clientWidth > 0 && img.clientWidth <= 64 && img.clientHeight > 0 && img.clientHeight <= 64) return true;

      return false;
    }

    /**
     * Checks if an image belongs to the user input composer or user message bubble.
     */
    isUserImageOrComposer(img) {
      if (!img) return true;
      return !!(
        img.closest('[data-message-author-role="user"]') ||
        img.closest('article[data-testid*="user" i]') ||
        img.closest('form') ||
        img.closest('#prompt-textarea') ||
        img.closest('[data-testid="composer"]')
      );
    }

    /**
     * Finds candidate generated images in the DOM across target assistant turns and OpenAI CDN assets.
     */
    findGeneratedImageCandidates() {
      const candidates = [];
      const seenUrls = new Set();

      // Wake up lazy-loaded images by scrolling to conversation end
      try {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
      } catch (e) {}

      const assistantMsgs = this.getAssistantMessages();
      const targetAssistantIndex = this.baselineAssistantCount || 0;
      const targetScopes = assistantMsgs.length > targetAssistantIndex
        ? assistantMsgs.slice(targetAssistantIndex)
        : [];

      // Strategy 1: Search target assistant turn and its enclosing article/turn container
      for (const scope of targetScopes) {
        if (!scope) continue;
        if (scope.getAttribute('data-message-author-role') === 'user' || scope.querySelector?.('[data-message-author-role="user"]')) {
          continue;
        }

        // Expand scope to parent article or turn container to capture sibling image widgets
        const container = scope.closest('article[data-testid^="conversation-turn-"]') || scope.closest('article') || scope.parentElement || scope;
        if (container.querySelector?.('[data-message-author-role="user"]')) {
          continue;
        }

        const imgs = Array.from(container.querySelectorAll('img'));
        for (const img of imgs) {
          const src = img.currentSrc || img.src;
          if (!src || seenUrls.has(src)) continue;
          if (this.isUserImageOrComposer(img)) continue;
          if (this.isAvatarOrUIElement(img)) continue;
          if (!this.existingImagesSnapshot.has(src)) {
            seenUrls.add(src);
            candidates.push({ img, src, priority: 3 });
          }
        }
      }

      // Strategy 2: High-confidence search across entire DOM for new OpenAI CDN / DALL-E images
      const allImgs = Array.from(document.querySelectorAll('img'));
      for (const img of allImgs) {
        const src = img.currentSrc || img.src;
        if (!src || seenUrls.has(src)) continue;
        if (this.isUserImageOrComposer(img)) continue;
        if (this.isAvatarOrUIElement(img)) continue;

        const isOaiCdn = src.includes('oaiusercontent.com') || src.includes('backend-api/files') || src.includes('oaistorage');
        const isBlob = src.startsWith('blob:') && !img.closest('[data-testid*="attachment"]');
        const isNew = !this.existingImagesSnapshot.has(src);

        if (isNew && (isOaiCdn || isBlob)) {
          seenUrls.add(src);
          candidates.push({ img, src, priority: isOaiCdn ? 2 : 1 });
        }
      }

      // Strategy 3: General fallback across DOM for any newly added non-avatar image
      for (const img of allImgs) {
        const src = img.currentSrc || img.src;
        if (!src || seenUrls.has(src)) continue;
        if (this.isUserImageOrComposer(img)) continue;
        if (this.isAvatarOrUIElement(img)) continue;

        if (!this.existingImagesSnapshot.has(src)) {
          seenUrls.add(src);
          candidates.push({ img, src, priority: 0 });
        }
      }

      // Sort by priority descending
      candidates.sort((a, b) => b.priority - a.priority);
      return candidates;
    }

    /**
     * Determines whether a candidate image is decoded or ready.
     */
    isImageReady(cand) {
      const img = cand.img;
      const src = cand.src;

      if (!src || (!src.startsWith('http') && !src.startsWith('blob:') && !src.startsWith('data:'))) {
        return false;
      }

      // 1. Direct OpenAI CDN URL - guaranteed ready
      if (src.includes('oaiusercontent.com') || src.includes('backend-api/files') || src.includes('oaistorage')) {
        return true;
      }

      // 2. Fully loaded DOM image with valid dimensions
      if (img.complete && (img.naturalWidth > 60 || img.clientWidth > 60)) {
        return true;
      }

      // 3. Blob URL with valid client size or completed status
      if (src.startsWith('blob:') && (img.complete || img.clientWidth > 60 || img.naturalWidth > 60)) {
        return true;
      }

      // 4. Data URL
      if (src.startsWith('data:image/')) {
        return true;
      }

      return false;
    }

    /**
     * Detects the newly generated image EXCLUSIVELY in the new assistant turn(s).
     */
    async detectNewGeneratedImage(timeoutMs = 45000) {
      const startTime = Date.now();
      console.log(`[PromptFlow] Scanning for newly generated image in turns after index ${this.baselineTurnCount}...`);

      while (Date.now() - startTime < timeoutMs) {
        const candidates = this.findGeneratedImageCandidates();
        if (candidates.length > 0) {
          const bestCandidate = candidates[0];
          if (this.isImageReady(bestCandidate)) {
            const finalSrc = bestCandidate.img?.currentSrc || bestCandidate.img?.src || bestCandidate.src;
            this.existingImagesSnapshot.add(finalSrc);
            console.log('[PromptFlow] Successfully detected new generated image:', finalSrc);
            return finalSrc;
          }
        }
        await sleep(500);
      }

      throw new Error('Newly generated image could not be detected within timeout');
    }

    /**
     * Efficiently waits for ChatGPT image generation to complete and returns the new image URL.
     * Searches strictly within the target assistant turn to NEVER detect user reference images.
     */
    async waitForGeneratedImage(timeoutMinutes = 3) {
      const timeoutMs = timeoutMinutes * 60 * 1000;
      const startTime = Date.now();
      const targetAssistantIndex = this.baselineAssistantCount || 0;
      console.log(`[PromptFlow] Monitoring for generated image in assistant turn >= index ${targetAssistantIndex}...`);

      // 1. Give ChatGPT up to 15s to initiate generation
      const startCheckUntil = Date.now() + 15000;
      while (Date.now() < startCheckUntil) {
        if (this.isGenerating()) {
          console.log('[PromptFlow] Generation start confirmed (stop button or streaming visible)');
          break;
        }
        const msgs = this.getAssistantMessages();
        if (msgs.length > targetAssistantIndex) {
          console.log('[PromptFlow] Generation start confirmed (new assistant turn created)');
          break;
        }
        await sleep(350);
      }

      // 2. Poll until generation STOPS and a new image is verified
      let candidateCheckCount = 0;
      while (Date.now() - startTime < timeoutMs) {
        // Immediate ChatGPT error banner detection
        const errorEl = document.querySelector('.text-red-500, [data-testid="error-message"], .border-red-500, [class*="error-message"]');
        if (errorEl && errorEl.textContent.trim().length > 0) {
          const errMsg = errorEl.textContent.trim();
          if (errMsg.toLowerCase().includes('error') || errMsg.toLowerCase().includes('violate') || errMsg.toLowerCase().includes('policy')) {
            throw new Error(`ChatGPT error: ${errMsg}`);
          }
        }

        const isGen = this.isGenerating();
        const candidates = this.findGeneratedImageCandidates();

        if (candidates.length > 0) {
          candidateCheckCount++;
          const bestCandidate = candidates[0];

          if (this.isImageReady(bestCandidate) || (!isGen && candidateCheckCount >= 3)) {
            const finalSrc = bestCandidate.img?.currentSrc || bestCandidate.img?.src || bestCandidate.src;
            if (finalSrc && (finalSrc.startsWith('http') || finalSrc.startsWith('blob:') || finalSrc.startsWith('data:'))) {
              this.existingImagesSnapshot.add(finalSrc);
              console.log('[PromptFlow] Confirmed generated image ready:', finalSrc);
              return finalSrc;
            }
          }
        } else if (!isGen && (Date.now() - startTime > 10000)) {
          // Check for refusal ONLY if generation has stopped, at least 10s have elapsed, and zero images were found
          const assistantMsgs = this.getAssistantMessages();
          if (assistantMsgs.length > targetAssistantIndex) {
            const latestTurn = assistantMsgs.slice(targetAssistantIndex);
            for (const scope of latestTurn) {
              const scopeText = (scope.textContent || '').toLowerCase();
              const isRefusal = /cannot\s+(?:generate|create)|unable\s+to\s+(?:generate|create)|violat(?:es?|ing)\s+(?:our\s+)?(?:content|safety)\s+policy|against\s+(?:our\s+)?(?:content|safety)\s+policy/i.test(scopeText);
              if (isRefusal && !scope.querySelector('img')) {
                throw new Error(`ChatGPT refusal: ${scope.textContent.trim().slice(0, 140)}`);
              }
            }
          }
        }

        await sleep(600);
      }

      throw new Error(`Image generation timed out after ${timeoutMinutes} minutes`);
    }
  }

  const adapter = new ChatGPTAdapter();

  /**
   * Floating overlay management for live, on-page visibility during automation
   */
  class OverlayManager {
    constructor() {
      this.hud = null;
      this.isMinimized = false;
      this.lastSession = null;
      this.lastIsDone = null;
      this.lastCount = null;
      this.dotEl = null;
      this.titleEl = null;
      this.stepEl = null;
      this.statusEl = null;
      this.progressFillEl = null;
      this.actionsEl = null;
      this.toggleBtn = null;
    }

    _mountHUD() {
      if (this.hud && document.body.contains(this.hud)) return;

      if (!this.hud) {
        this.hud = document.createElement('div');
        this.hud.className = 'promptflow-floating-hud';
      }

      this.hud.innerHTML = `
        <div class="promptflow-hud-header">
          <div class="promptflow-hud-brand">
            <div class="promptflow-badge-dot" id="promptflow-hud-dot"></div>
            <span id="promptflow-hud-title">PromptFlow</span>
          </div>
          <span class="promptflow-hud-step" id="promptflow-hud-step">0 / 0 Ready</span>
          <button type="button" class="promptflow-hud-btn-min" id="promptflow-btn-toggle" title="Minimize">—</button>
        </div>
        <div class="promptflow-hud-body">
          <div class="promptflow-hud-status" id="promptflow-hud-status" title="Running...">Running...</div>
          <div class="promptflow-hud-progress-track">
            <div class="promptflow-hud-progress-fill" id="promptflow-hud-progress-fill" style="width: 0%"></div>
          </div>
        </div>
        <div class="promptflow-hud-actions" id="promptflow-hud-actions"></div>
      `;

      if (!document.body.contains(this.hud)) {
        document.body.appendChild(this.hud);
      }

      this.dotEl = this.hud.querySelector('#promptflow-hud-dot');
      this.titleEl = this.hud.querySelector('#promptflow-hud-title');
      this.stepEl = this.hud.querySelector('#promptflow-hud-step');
      this.statusEl = this.hud.querySelector('#promptflow-hud-status');
      this.progressFillEl = this.hud.querySelector('#promptflow-hud-progress-fill');
      this.actionsEl = this.hud.querySelector('#promptflow-hud-actions');
      this.toggleBtn = this.hud.querySelector('#promptflow-btn-toggle');

      if (this.toggleBtn) {
        this.toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.isMinimized = !this.isMinimized;
          if (this.isMinimized) {
            this.hud.classList.add('minimized');
            this.toggleBtn.textContent = '▢';
            this.toggleBtn.title = 'Expand';
          } else {
            this.hud.classList.remove('minimized');
            this.toggleBtn.textContent = '—';
            this.toggleBtn.title = 'Minimize';
          }
        });
      }
    }

    createOrUpdateHUD(session, overrideTitle = '', overrideStatus = '') {
      if (session) this.lastSession = session;
      const activeSession = session || this.lastSession;

      this._mountHUD();

      const state = activeSession?.state || 'active';
      const statusMsg = overrideStatus || activeSession?.statusMessage || 'Running...';
      const title = overrideTitle || 'PromptFlow';
      const prompts = activeSession?.prompts || [];
      const enabled = prompts.filter(p => p.enabled && p.text.trim());
      const completed = prompts.filter(p => p.status === 'completed');
      const total = enabled.length || 1;
      const count = completed.length;
      const pct = Math.round((count / total) * 100);
      const isDone = state === 'completed' || (count >= total && count > 0);

      const dotClass = state === 'waiting_for_generation' || state === 'sending_prompt' || state === 'uploading_reference'
        ? 'generating'
        : isDone ? 'completed' : state === 'error' ? 'error' : '';

      // Surgical DOM updates without destroying elements
      if (this.titleEl && this.titleEl.textContent !== title) {
        this.titleEl.textContent = title;
      }
      if (this.statusEl) {
        if (this.statusEl.textContent !== statusMsg) this.statusEl.textContent = statusMsg;
        if (this.statusEl.title !== statusMsg) this.statusEl.title = statusMsg;
      }
      const stepText = `${count} / ${total} Ready`;
      if (this.stepEl && this.stepEl.textContent !== stepText) {
        this.stepEl.textContent = stepText;
      }
      if (this.dotEl) {
        const fullDotClass = 'promptflow-badge-dot' + (dotClass ? ' ' + dotClass : '');
        if (this.dotEl.className !== fullDotClass) {
          this.dotEl.className = fullDotClass;
        }
      }
      if (this.progressFillEl) {
        this.progressFillEl.style.width = `${pct}%`;
      }

      if (this.actionsEl && (this.lastIsDone !== isDone || this.lastCount !== count)) {
        this.lastIsDone = isDone;
        this.lastCount = count;
        if (isDone) {
          this.actionsEl.innerHTML = `<button type="button" class="promptflow-hud-btn promptflow-hud-btn-download" id="promptflow-btn-hud-dl">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Download All (${count})</span>
          </button>`;
          const dlBtn = this.actionsEl.querySelector('#promptflow-btn-hud-dl');
          if (dlBtn) {
            dlBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              chrome.runtime.sendMessage({ type: 'DOWNLOAD_ALL' });
            });
          }
        } else {
          this.actionsEl.innerHTML = `<button type="button" class="promptflow-hud-btn promptflow-hud-btn-stop" id="promptflow-btn-hud-stop">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
            <span>Stop Automation</span>
          </button>`;
          const stopBtn = this.actionsEl.querySelector('#promptflow-btn-hud-stop');
          if (stopBtn) {
            stopBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION' });
            });
          }
        }
      }
    }

    createOrUpdate(title, status, state = 'info') {
      this.createOrUpdateHUD(null, title, status);
    }

    remove() {
      if (this.hud && this.hud.parentNode) {
        this.hud.parentNode.removeChild(this.hud);
      }
      this.hud = null;
      this.dotEl = null;
      this.titleEl = null;
      this.stepEl = null;
      this.statusEl = null;
      this.progressFillEl = null;
      this.actionsEl = null;
      this.toggleBtn = null;
      this.lastIsDone = null;
      this.lastCount = null;
    }
  }

  const overlay = new OverlayManager();

  /**
   * Content script message listener
   * Receives commands from background service worker
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[PromptFlow Content] Received message:', message.type);

    (async () => {
      try {
        switch (message.type) {
          case 'SYNC_SESSION_OVERLAY': {
            overlay.createOrUpdateHUD(message.session);
            sendResponse({ success: true });
            break;
          }

          case 'PING': {
            const composer = adapter.findComposer();
            const authenticated = adapter.isAuthenticated();
            sendResponse({
              success: true,
              authenticated,
              ready: !!composer,
              url: window.location.href
            });
            break;
          }

          case 'START_NEW_CHAT': {
            overlay.createOrUpdate('PromptFlow', 'Starting fresh chat in same tab...', 'info');
            const success = await adapter.startNewChat();
            sendResponse({ success });
            break;
          }

          case 'PREPARE_REFERENCE_UPLOAD': {
            overlay.createOrUpdate('PromptFlow', 'Uploading Reference Image...', 'generating');
            const success = await adapter.uploadReference(message.fileData);
            sendResponse({ success });
            break;
          }

          case 'TAKE_IMAGE_SNAPSHOT': {
            const result = adapter.snapshotBeforePrompt();
            sendResponse({ success: true, count: result.count, baselineTurns: result.baselineTurns });
            break;
          }

          case 'SUBMIT_PROMPT': {
            overlay.createOrUpdate('PromptFlow', `Sending Prompt ${message.promptIndex}...`, 'generating');
            await adapter.insertAndSubmitPrompt(message.promptText);
            sendResponse({ success: true });
            break;
          }

          case 'WAIT_AND_DETECT_IMAGE': {
            overlay.createOrUpdate('PromptFlow', `Generating image ${message.promptIndex}...`, 'generating');
            const imageUrl = await adapter.waitForGeneratedImage(message.timeoutMinutes || 3);
            overlay.createOrUpdate('PromptFlow', `Image ${message.promptIndex} ready!`, 'completed');
            sendResponse({ success: true, imageUrl });
            break;
          }

          case 'WAIT_GENERATION': {
            overlay.createOrUpdate('PromptFlow', `Generating image ${message.promptIndex}...`, 'generating');
            await adapter.waitForGenerationStart(25000);
            await adapter.waitForGenerationComplete(message.timeoutMinutes || 5);
            sendResponse({ success: true });
            break;
          }

          case 'DETECT_NEW_IMAGE': {
            overlay.createOrUpdate('PromptFlow', `Detecting generated image ${message.promptIndex}...`, 'info');
            const imageUrl = await adapter.detectNewGeneratedImage(50000);
            sendResponse({ success: true, imageUrl });
            break;
          }

          case 'UPDATE_BADGE': {
            overlay.createOrUpdate(message.title || 'PromptFlow', message.status || '', message.state || 'info');
            sendResponse({ success: true });
            break;
          }

          case 'FETCH_IMAGE_DATA': {
            try {
              let blob = null;
              try {
                const resp = await fetch(message.url);
                if (resp.ok) blob = await resp.blob();
              } catch (fetchErr) {
                console.warn('[PromptFlow Content] Direct fetch in tab failed, trying canvas extraction:', fetchErr.message);
              }

              if (blob) {
                const reader = new FileReader();
                reader.onload = () => sendResponse({ success: true, dataUrl: reader.result });
                reader.onerror = () => sendResponse({ success: false, error: 'FileReader failed' });
                reader.readAsDataURL(blob);
              } else {
                // Canvas extraction fallback: find the image element in DOM
                const img = Array.from(document.querySelectorAll('img')).find(
                  (i) => i.src === message.url || i.currentSrc === message.url
                );
                if (img && (img.naturalWidth > 0 || img.complete)) {
                  try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || 512;
                    canvas.height = img.naturalHeight || 512;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const dataUrl = canvas.toDataURL('image/png');
                    sendResponse({ success: true, dataUrl });
                  } catch (canvasErr) {
                    sendResponse({ success: false, error: `Canvas extraction failed: ${canvasErr.message}` });
                  }
                } else {
                  sendResponse({ success: false, error: 'Could not fetch image data or find element in DOM' });
                }
              }
            } catch (err) {
              sendResponse({ success: false, error: err.message });
            }
            break;
          }

          case 'REMOVE_BADGE': {
            overlay.remove();
            sendResponse({ success: true });
            break;
          }

          default:
            sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
        }
      } catch (err) {
        console.error('[PromptFlow Content Error]', err);
        overlay.createOrUpdate('PromptFlow', `Error: ${err.message}`, 'error');
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // Keep message channel open for async response
  });
})();

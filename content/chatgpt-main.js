// content/chatgpt-main.js
// Runs in ChatGPT's MAIN execution world with direct access to Lexical editor state and React DOM.
// Enables seamless, instant prompt insertion and single-click dispatch even when tab is backgrounded / off-screen.

(function () {
  if (window.__promptflow_main_installed) return;
  window.__promptflow_main_installed = true;

  console.log('[PromptFlow Main] Main World Lexical Bridge ready');

  window.addEventListener('__PROMPTFLOW_MAIN_SUBMIT__', async (event) => {
    const { promptText, nonce } = event.detail || {};
    if (!promptText) return;

    try {
      // 1. Locate composer in DOM
      const composer =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-lexical-editor="true"]') ||
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector('textarea[data-id="root"]') ||
        document.querySelector('form textarea');

      if (!composer) {
        throw new Error('ChatGPT composer input could not be found');
      }

      composer.focus();

      const requiredSnippet = promptText.trim().slice(0, 20);

      // Method 1: Native execCommand insertText (updates Lexical AND React state naturally)
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, promptText);
      } catch (e) {}

      // Method 2: Synthetic Clipboard paste event (Lexical's native multiline handler)
      let currentText = (composer.innerText || composer.textContent || '').trim();
      if (!currentText.includes(requiredSnippet.slice(0, 15))) {
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', promptText);
          composer.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          }));
        } catch (e) {}
      }

      // Method 3: Direct Lexical editor state synchronization if needed
      const editor = composer.__lexicalEditor;
      if (editor && typeof editor.setEditorState === 'function') {
        try {
          currentText = (composer.innerText || composer.textContent || '').trim();
          if (!currentText.includes(requiredSnippet.slice(0, 15)) && typeof editor.parseEditorState === 'function') {
            const lines = promptText.split(/\r?\n/);
            const paragraphs = lines.map((line) => {
              const children = line.length > 0 ? [{
                detail: 0,
                format: 0,
                mode: 'normal',
                text: line,
                type: 'text',
                version: 1
              }] : [];
              return {
                children,
                direction: 'ltr',
                format: '',
                indent: 0,
                type: 'paragraph',
                version: 1
              };
            });

            const stateData = {
              root: {
                children: paragraphs,
                direction: 'ltr',
                format: '',
                indent: 0,
                type: 'root',
                version: 1
              }
            };

            const newState = editor.parseEditorState(JSON.stringify(stateData));
            editor.setEditorState(newState);
            console.log('[PromptFlow Main] Lexical state directly populated via parseEditorState');
          }
        } catch (parseErr) {
          console.warn('[PromptFlow Main] parseEditorState note:', parseErr);
        }
      }

      // Dispatch native input pipeline events for React & Lexical reconciliation
      composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: promptText }));
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: promptText }));
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));

      // Give React 500ms to reconcile its internal state with the new text
      await new Promise((r) => setTimeout(r, 500));

      // 3. Poll for Send button readiness AND verify prompt text is committed in composer
      const findSendBtn = () =>
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Send" i]') ||
        document.querySelector('button[data-testid="fruitjuice-send-button"]') ||
        composer.closest('form')?.querySelector('button[type="submit"]');

      const getComposerText = () =>
        (composer.innerText || composer.textContent || composer.value || '').trim();

      let sendBtn = null;
      const pollStart = Date.now();
      const maxWait = 4000;

      while (Date.now() - pollStart < maxWait) {
        sendBtn = findSendBtn();
        const isAriaDisabled = sendBtn?.getAttribute('aria-disabled') === 'true';
        const isDisabled = sendBtn?.disabled;
        const textInComposer = getComposerText();
        const textConfirmed = textInComposer.length > 0 && textInComposer.includes(requiredSnippet.slice(0, 15));

        // CRITICAL GUARD: Both send button ready AND text verified present in composer!
        // Prevents prematurely sending reference image alone when sendBtn is enabled by attachment!
        if (sendBtn && !isDisabled && !isAriaDisabled && textConfirmed) {
          break;
        }

        // Re-notify React & Lexical if text not yet reflected
        if (!textConfirmed) {
          composer.focus();
          try {
            document.execCommand('insertText', false, promptText);
          } catch (e) {}
        }

        composer.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
      }

      const finalContent = getComposerText();
      const hasVerifiedText = finalContent.length > 0 && finalContent.includes(requiredSnippet.slice(0, 15));

      if (!hasVerifiedText) {
        throw new Error('Prompt text verification failed in composer; aborted to avoid sending attachment alone.');
      }

      if (sendBtn) {
        sendBtn.removeAttribute('disabled');
        sendBtn.setAttribute('aria-disabled', 'false');
        sendBtn.disabled = false;
        sendBtn.click();
        console.log('[PromptFlow Main] Send button clicked cleanly with prompt text verified');
      } else {
        // Fallback: Enter key ONLY if prompt text is verified present
        const enterEvt = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        composer.dispatchEvent(enterEvt);
      }

      window.dispatchEvent(
        new CustomEvent('__PROMPTFLOW_MAIN_DONE__', {
          detail: { nonce, success: true }
        })
      );
    } catch (err) {
      console.error('[PromptFlow Main Error]', err);
      window.dispatchEvent(
        new CustomEvent('__PROMPTFLOW_MAIN_DONE__', {
          detail: { nonce, success: false, error: err.message }
        })
      );
    }
  });
})();

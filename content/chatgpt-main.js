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

      // 2. Direct Lexical state update if __lexicalEditor is accessible
      const editor = composer.__lexicalEditor;
      let stateUpdated = false;

      if (editor && typeof editor.parseEditorState === 'function') {
        try {
          // Split multiline prompts into valid Lexical paragraphs to prevent schema validation rejection
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
          stateUpdated = true;
          console.log('[PromptFlow Main] Lexical state directly populated via parseEditorState (multiline safe)');
        } catch (parseErr) {
          console.warn('[PromptFlow Main] parseEditorState note:', parseErr);
        }
      }

      if (!stateUpdated) {
        // Fallback: Lexical compliant DOM structure with multiline paragraph nodes
        composer.innerHTML = '';
        const lines = promptText.split(/\r?\n/);
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

        // Also update value if textarea
        if ('value' in composer) {
          composer.value = promptText;
        }
      }

      // Dispatch native input pipeline events for React & Lexical reconciliation
      composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: promptText }));
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: promptText }));
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));

      // 3. Poll for Send button readiness (allow React to reconcile state naturally)
      const findSendBtn = () =>
        document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Send" i]') ||
        document.querySelector('button[data-testid="fruitjuice-send-button"]') ||
        composer.closest('form')?.querySelector('button[type="submit"]');

      let sendBtn = null;
      const pollStart = Date.now();
      const maxWait = 2500;

      while (Date.now() - pollStart < maxWait) {
        sendBtn = findSendBtn();
        const isAriaDisabled = sendBtn?.getAttribute('aria-disabled') === 'true';
        const isDisabled = sendBtn?.disabled;

        if (sendBtn && !isDisabled && !isAriaDisabled) {
          break;
        }

        // Keep React state notified
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
      }

      if (sendBtn) {
        sendBtn.removeAttribute('disabled');
        sendBtn.setAttribute('aria-disabled', 'false');
        sendBtn.disabled = false;
        sendBtn.click();
        console.log('[PromptFlow Main] Send button clicked cleanly (single dispatch)');
      } else {
        // Fallback: Enter key
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

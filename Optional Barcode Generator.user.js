// ==UserScript==
// @name         Backtick Clipboard Saver - Barcode Module
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Optional add-on for Backtick Clipboard Saver. Injects a scanner-optimized hover barcode.
// @author       Gemini
// @match        *://*/*
// @require      https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @downloadURL  https://github.com/Vpaigewi/saving-items-tool/raw/refs/heads/main/Optional%20Barcode%20Generator.user.js
// @updateURL    https://github.com/Vpaigewi/saving-items-tool/raw/refs/heads/main/Optional%20Barcode%20Generator.user.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Prevent running inside iframes
    if (window.top !== window.self) return;

    // Load the independent state for this module
    let isBarcodeEnabled = GM_getValue('gcs_barcode_module_enabled', true);

    // ==========================================
    // GLOBAL TOOLTIP SETUP
    // ==========================================
    
    let tooltip = document.getElementById('gcs-barcode-tooltip');
    let tooltipSvg;
    
    // Create the global floating tooltip container once
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'gcs-barcode-tooltip';
        tooltip.style.position = 'fixed';
        tooltip.style.display = 'none';
        tooltip.style.zIndex = '2147483647'; // Ensure it floats above absolutely everything
        // Barcode scanners require high contrast, so we force white/black regardless of dark mode
        tooltip.style.backgroundColor = '#ffffff'; 
        tooltip.style.border = '2px solid #333333';
        tooltip.style.padding = '15px';
        tooltip.style.borderRadius = '8px';
        tooltip.style.boxShadow = '0 15px 35px rgba(0,0,0,0.6)';
        tooltip.style.pointerEvents = 'none'; // Prevent the tooltip from blocking mouse movements

        tooltipSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        tooltip.appendChild(tooltipSvg);
        document.body.appendChild(tooltip);
    } else {
        tooltipSvg = tooltip.querySelector('svg');
    }

    // ==========================================
    // UI INJECTION LOGIC
    // ==========================================

    function injectSettings() {
        const settingsPanel = document.querySelector('.gcs-settings-panel');
        
        // Only inject if the panel exists and we haven't already injected the toggle
        if (!settingsPanel || document.getElementById('gcs-barcode-setting')) {
            return;
        }

        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.id = 'gcs-barcode-setting';

        const lbl = document.createElement('span');
        lbl.textContent = 'Enable Barcodes:';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isBarcodeEnabled;
        
        cb.addEventListener('change', (e) => {
            isBarcodeEnabled = e.target.checked;
            GM_setValue('gcs_barcode_module_enabled', isBarcodeEnabled);
            
            // The main script has a focus listener that wipes and redraws the UI.
            // Dispatching a fake focus event forces the main app to cleanly re-render 
            // the list, which will instantly add or remove our barcode buttons!
            window.dispatchEvent(new Event('focus'));
        });

        row.appendChild(lbl);
        row.appendChild(cb);
        
        // Insert this cleanly above the "Save Defaults" button
        const defaultsBtn = Array.from(settingsPanel.children).find(el => el.tagName === 'BUTTON' && el.textContent.includes('Default'));
        if (defaultsBtn) {
            settingsPanel.insertBefore(row, defaultsBtn);
        } else {
            settingsPanel.appendChild(row);
        }
    }

    function processRow(row) {
        if (!isBarcodeEnabled) return;

        // Prevent adding duplicate buttons if the observer fires twice
        if (row.querySelector('.gcs-barcode-btn')) return;

        const cs = row.querySelector('.cs');
        
        // The main script structure uses a div for the button controls
        const controls = Array.from(row.children).find(el => el.tagName === 'DIV');
        
        if (!cs || !controls) return;
        
        // Barcodes only apply to text, so ignore rows containing images
        if (cs.querySelector('img')) return;

        // The main script hides the full, untruncated text inside the span's title attribute
        const fullText = cs.title; 
        if (!fullText) return;

        const barcodeBtn = document.createElement('button');
        barcodeBtn.className = 'gcs-barcode-btn';
        barcodeBtn.textContent = '║▌║';
        barcodeBtn.style.cursor = 'help'; // Use the help cursor to indicate a hover action
        barcodeBtn.style.padding = '4px 6px';
        barcodeBtn.style.border = 'none';
        barcodeBtn.style.background = 'transparent';
        barcodeBtn.style.fontSize = '12px';
        barcodeBtn.style.fontWeight = 'bold';
        barcodeBtn.style.color = 'var(--gcs-text)';
        barcodeBtn.style.marginRight = '4px';

        // Match the hover physics of the main script
        barcodeBtn.addEventListener('mouseover', () => barcodeBtn.style.backgroundColor = 'var(--gcs-btn-bg)');
        barcodeBtn.addEventListener('mouseout', () => barcodeBtn.style.backgroundColor = 'transparent');

        // Render and Show the Tooltip
        barcodeBtn.addEventListener('mouseenter', () => {
            try {
                // Generate a large, highly readable barcode
                JsBarcode(tooltipSvg, fullText, {
                    height: 80,             // Large height for easy scanning
                    displayValue: true,     // Show the text below the barcode
                    margin: 0,
                    background: '#ffffff',  // Force White
                    lineColor: '#000000',   // Force Black
                    fontSize: 18,
                    fontOptions: "bold"
                });
                
                // Show the tooltip so we can measure it
                tooltip.style.display = 'block';
                
                // Calculate physical coordinates
                const btnRect = barcodeBtn.getBoundingClientRect();
                const ttRect = tooltip.getBoundingClientRect();
                
                // Try to place it to the left of the main widget
                let targetLeft = btnRect.left - ttRect.width - 20;
                
                // If there isn't room on the left, place it on the right
                if (targetLeft < 10) {
                    targetLeft = btnRect.right + 20;
                }
                
                // Vertically align the center of the barcode with the button
                let targetTop = btnRect.top + (btnRect.height / 2) - (ttRect.height / 2);
                
                // Keep it from clipping off the top or bottom of the monitor
                if (targetTop < 10) targetTop = 10;
                if (targetTop + ttRect.height > window.innerHeight - 10) {
                    targetTop = window.innerHeight - ttRect.height - 10;
                }
                
                // Apply the calculated positions
                tooltip.style.left = targetLeft + 'px';
                tooltip.style.top = targetTop + 'px';
                
                barcodeBtn.style.color = '#4CAF50'; // Highlight the button to show it's active
                
            } catch (e) {
                // Silently fail if the text contains unsupported barcode characters
                console.warn("Barcode generation failed for string:", fullText);
            }
        });

        // Hide the Tooltip
        barcodeBtn.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
            barcodeBtn.style.color = 'var(--gcs-text)';
        });
        
        // Optional: Click the button to copy the raw text to clipboard as a fallback
        barcodeBtn.addEventListener('click', () => {
             GM_setClipboard(fullText, 'text');
        });

        // Insert our new button right before the Left Arrow "Push" button
        controls.insertBefore(barcodeBtn, controls.firstChild);
    }

    // ==========================================
    // DOM OBSERVER ENGINE
    // ==========================================

    // The observer runs quietly in the background and reacts whenever the main script draws UI
    const observer = new MutationObserver((mutations) => {
        injectSettings();

        const listContainer = document.querySelector('.gcs-list-scroll');
        if (listContainer) {
            // Find all the rows (the main app renders rows as display:flex divs directly inside the scroll container)
            const rows = Array.from(listContainer.children).filter(el => el.tagName === 'DIV' && el.style.display === 'flex');
            rows.forEach(processRow);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();

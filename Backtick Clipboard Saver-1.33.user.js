// ==UserScript==
// @name         Backtick Clipboard Saver (Desktop Sync Edition)
// @namespace    http://tampermonkey.net/
// @version      1.35
// @description  Hold ` to save. Syncs with Local Electron App. Fixed empty-array initialization crash.
// @author       Gemini
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @downloadURL  https://github.com/Vpaigewi/saving-items-tool/raw/refs/heads/desktop-sync/Backtick%20Clipboard%20Saver-1.33.user.js
// @updateURL    https://github.com/Vpaigewi/saving-items-tool/raw/refs/heads/desktop-sync/Backtick%20Clipboard%20Saver-1.33.user.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Prevent the script from running inside hidden iframes or background tasks
    if (window.top !== window.self) {
        return;
    }

    // ==========================================
    // 1. STATE & SETTINGS MANAGEMENT
    // ==========================================

    // Define the default user settings
    let defaultSettings = {
        hotkey: '`',
        maxItems: 10,
        autoCollapse: false,
        fontSize: '13px',
        widgetTitle: 'Saved Items',
        askBeforeClear: true
    };
    
    // Load the main user settings object from storage
    let settings = GM_getValue('gcs_settings', defaultSettings);

    // Failsafe: Ensure older settings objects get the newest properties
    if (settings.widgetTitle === undefined) {
        settings.widgetTitle = 'Saved Items';
    }
    if (settings.askBeforeClear === undefined) {
        settings.askBeforeClear = true;
    }

    // Interaction flags
    let isTriggerDown = false;
    let isCombining = false; 
    let hasClickedWhileTriggerDown = false;
    let isSettingsOpen = false;
    let isDashboardOpen = false;
    
    // Tracks which tab is currently being dragged
    let draggedTabId = null;

    // Load the saved clipboard items
    let rawSavedItems = GM_getValue('saved_clicks', []);
    
    // Force old items into the strict {type, text} object format
    let savedItems = rawSavedItems.map(function(item) {
        if (typeof item === 'string') {
            return { type: 'text', text: item };
        }
        if (item.plain !== undefined) {
            return { type: 'text', text: item.plain }; 
        }
        if (item.type === undefined) {
            return { type: 'text', text: item.text };
        }
        return item;
    });

    // Load UI toggle states
    let isMinimized = GM_getValue('is_minimized', false);
    let isDarkMode = GM_getValue('is_dark_mode', true);
    let isNotepadOpen = GM_getValue('is_notepad_open', false);
    let isCoupled = GM_getValue('is_coupled', true); 

    // Load the Scratchpad tabs
    let defaultTabs = [
        { id: Date.now(), title: 'Note 1', text: '', type: 'text', color: '', textColor: '' }
    ];
    let rawTabs = GM_getValue('notepad_tabs', defaultTabs);
    
    // --- CRITICAL BUG FIX ---
    // If the storage accidentally saved an empty array, force it back to defaults so it doesn't crash!
    if (Array.isArray(rawTabs) === false || rawTabs.length === 0) {
        rawTabs = [
            { id: Date.now(), title: 'Note 1', text: '', type: 'text', color: '', textColor: '' }
        ];
    }
    
    // Ensure all tabs have the new properties
    let notepadTabs = rawTabs.map(function(tab) {
        if (tab.type === undefined) {
            tab.type = 'text'; 
        }
        if (tab.textColor === undefined) {
            tab.textColor = ''; 
        }
        return tab;
    });
    
    // Load the active tab ID. Because of the failsafe above, notepadTabs[0] will ALWAYS exist.
    let activeTabId = GM_getValue('active_tab_id', notepadTabs[0].id);
    let activeTabExists = notepadTabs.find(function(t) { 
        return t.id === activeTabId; 
    });
    
    // Fallback if the saved active tab was somehow deleted
    if (activeTabExists === undefined) {
        activeTabId = notepadTabs[0].id;
    }

    // ==========================================
    // 2. DESKTOP SYNC ENGINE
    // ==========================================

    // Pushes the current browser state to the Electron Desktop app
    function pushToDesktop() {
        const payload = {
            savedItems: savedItems,
            notepadTabs: notepadTabs,
            settings: settings
        };
        const payloadString = JSON.stringify(payload);
        
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:9876/sync',
            headers: {
                'Content-Type': 'application/json'
            },
            data: payloadString,
            onload: function(response) {
                // Request succeeded, desktop app was updated silently
            },
            onerror: function(error) {
                // Desktop app is closed or unreachable. 
                // We ignore this silently so the browser extension continues to work locally.
            }
        });
    }

    // Pulls the latest state from the Electron Desktop app
    function pullFromDesktop() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'http://localhost:9876/sync',
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const parsedData = JSON.parse(response.responseText);
                        let needsRender = false;
                        
                        if (parsedData.savedItems !== undefined) {
                            savedItems = parsedData.savedItems;
                            GM_setValue('saved_clicks', savedItems);
                            needsRender = true;
                        }
                        
                        // Safety check: Only accept the sync if the notepad array actually has items in it
                        if (parsedData.notepadTabs !== undefined) {
                            if (Array.isArray(parsedData.notepadTabs) === true && parsedData.notepadTabs.length > 0) {
                                notepadTabs = parsedData.notepadTabs;
                                GM_setValue('notepad_tabs', notepadTabs);
                                needsRender = true;
                            }
                        }
                        
                        if (parsedData.settings !== undefined) {
                            settings = parsedData.settings;
                            GM_setValue('gcs_settings', settings);
                            // Ensure the DOM updates if dark mode was toggled from desktop
                            if (settings.isDarkMode !== undefined) {
                                isDarkMode = settings.isDarkMode;
                                GM_setValue('is_dark_mode', isDarkMode);
                                if (isDarkMode === true) {
                                    document.documentElement.classList.add('gcs-dark-mode');
                                } else {
                                    document.documentElement.classList.remove('gcs-dark-mode');
                                }
                            }
                        }
                        
                        if (needsRender === true) {
                            renderList();
                            renderTabs();
                            if (isDashboardOpen === true) {
                                renderLiveDashboard();
                            }
                        }
                    } catch (e) {
                        // Data from server was corrupted or not JSON. Ignore it.
                    }
                }
            },
            onerror: function(error) {
                // Desktop app is closed. Continue relying on Tampermonkey local storage.
            }
        });
    }

    // ==========================================
    // 3. POSITION & SIZE FAILSAFES
    // ==========================================
    
    const defaultMainPos = { right: '20px', bottom: '20px', left: 'auto', top: 'auto' };
    const defaultNotePos = { right: '310px', bottom: '20px', left: 'auto', top: 'auto' };
    const defaultMainSize = { width: '270px', height: '400px' };
    const defaultNoteSize = { width: '240px', height: '400px' };

    // Function to purge corrupt size strings
    function sanitizeSize(obj, fallback) {
        if (obj === undefined || obj === null) {
            return fallback;
        }
        const cleanObj = { ...obj };
        for (const key in cleanObj) {
            const val = cleanObj[key];
            if (typeof val !== 'string') {
                return fallback;
            }
            if (val.includes('NaN') === true || val.includes('undefined') === true || val.includes('null') === true) {
                return fallback; 
            }
        }
        return cleanObj;
    }

    let mainSize = sanitizeSize(GM_getValue('main_size', defaultMainSize), defaultMainSize);
    let noteSize = sanitizeSize(GM_getValue('note_size', defaultNoteSize), defaultNoteSize);

    // Safely load Positions and prioritize absolute Left/Top coordinates if they exist
    let rawMainPos = GM_getValue('main_pos', null);
    let mainPos = defaultMainPos;
    if (rawMainPos !== null && rawMainPos.left !== undefined && rawMainPos.left !== 'auto') {
        mainPos = { left: rawMainPos.left, top: rawMainPos.top, right: 'auto', bottom: 'auto' };
    }

    let rawNotePos = GM_getValue('note_pos', null);
    let notePos = defaultNotePos;
    if (rawNotePos !== null && rawNotePos.left !== undefined && rawNotePos.left !== 'auto') {
        notePos = { left: rawNotePos.left, top: rawNotePos.top, right: 'auto', bottom: 'auto' };
    }

    // ==========================================
    // 4. PANIC BUTTON LOGIC
    // ==========================================

    window.addEventListener('keydown', function(e) {
        // Look for: Ctrl + Alt + 0
        if (e.ctrlKey === true && e.altKey === true && e.key === '0') {
            e.preventDefault();
            
            // Delete user-defined default layouts to clear corruption
            GM_deleteValue('default_gcs_config');
            
            // Force main widget to factory defaults
            mainWidget.style.left = 'auto';
            mainWidget.style.top = 'auto';
            mainWidget.style.right = defaultMainPos.right;
            mainWidget.style.bottom = defaultMainPos.bottom;
            mainWidget.style.width = defaultMainSize.width;
            mainWidget.style.height = defaultMainSize.height;

            // Force notepad widget to factory defaults
            notepadWrapper.style.left = 'auto';
            notepadWrapper.style.top = 'auto';
            notepadWrapper.style.right = defaultNotePos.right;
            notepadWrapper.style.bottom = defaultNotePos.bottom;
            notepadWrapper.style.width = defaultNoteSize.width;
            notepadWrapper.style.height = defaultNoteSize.height;

            // Force coupling back ON
            isCoupled = true;
            GM_setValue('is_coupled', true);
            magnetBtn.style.opacity = '1';

            // Ensure window is expanded
            isMinimized = false;
            GM_setValue('is_minimized', false);
            toggleBtn.textContent = '−';

            // Save the clean coordinates
            savePosSize();
            
            alert('Panic Button Triggered!\n\nWidget has been factory reset and moved to the bottom right.');
        }
    });

    // ==========================================
    // 5. DOM CONTAINERS
    // ==========================================

    const notepadWrapper = document.createElement('div');
    notepadWrapper.className = 'gcs-floating-widget'; 
    notepadWrapper.id = 'gcs-note-widget';
    
    const mainWidget = document.createElement('div');
    mainWidget.className = 'gcs-floating-widget'; 
    mainWidget.id = 'gcs-main-widget';

    // The Live Overlay Container
    const dashboardOverlay = document.createElement('div');
    dashboardOverlay.id = 'gcs-live-dashboard';

    let mainWInput;
    let mainHInput;
    let noteWInput;
    let noteHInput;

    // ==========================================
    // 6. DRAG & DROP LOGIC (WINDOWS)
    // ==========================================

    let dragRelGapX = 0;
    let dragRelGapY = 0;

    // Brings the clicked window to the front
    function bringToFront(widget) {
        const allWidgets = document.querySelectorAll('.gcs-floating-widget');
        allWidgets.forEach(function(w) {
            w.style.zIndex = '2147483646';
        });
        widget.style.zIndex = '2147483647';
    }

    // Applies drag-and-drop listeners to a header handle
    function makeDraggable(handle, draggedContainer) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let rectDrag = null;
        let rectOther = null;
        
        let otherContainer = null;
        if (draggedContainer === mainWidget) {
            otherContainer = notepadWrapper;
        } else {
            otherContainer = mainWidget;
        }

        handle.addEventListener('mousedown', function(e) {
            const tag = e.target.tagName.toLowerCase();
            const isInteractive = ['button', 'input', 'select', 'textarea'].includes(tag);
            const isScrollbar = e.offsetX > e.target.clientWidth || e.offsetY > e.target.clientHeight;
            
            if (isInteractive === true || isScrollbar === true) {
                return; 
            }
            
            isDragging = true;
            startX = e.clientX; 
            startY = e.clientY;
            
            // Switch from right/bottom positioning to left/top positioning for dragging
            rectDrag = draggedContainer.getBoundingClientRect();
            draggedContainer.style.left = rectDrag.left + 'px'; 
            draggedContainer.style.top = rectDrag.top + 'px';
            draggedContainer.style.bottom = 'auto';
            draggedContainer.style.right = 'auto';

            if (isCoupled === true && isNotepadOpen === true) {
                rectOther = otherContainer.getBoundingClientRect();
                otherContainer.style.left = rectOther.left + 'px'; 
                otherContainer.style.top = rectOther.top + 'px';
                otherContainer.style.bottom = 'auto';
                otherContainer.style.right = 'auto';
                
                // Calculate the fixed gap between the two windows
                dragRelGapX = rectOther.left - rectDrag.left; 
                dragRelGapY = rectOther.top - rectDrag.top;
            }
            bringToFront(draggedContainer);
        });

        document.addEventListener('mousemove', function(e) {
            if (isDragging === false) {
                return;
            }
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            draggedContainer.style.left = (rectDrag.left + dx) + 'px'; 
            draggedContainer.style.top = (rectDrag.top + dy) + 'px';
            
            if (isCoupled === true && isNotepadOpen === true) { 
                otherContainer.style.left = (rectDrag.left + dx + dragRelGapX) + 'px'; 
                otherContainer.style.top = (rectDrag.top + dy + dragRelGapY) + 'px'; 
            }
        });

        document.addEventListener('mouseup', function() { 
            if (isDragging === true) { 
                isDragging = false; 
                savePosSize(); 
            }
        });
    }

    // Saves the current position and size to Tampermonkey storage
    function savePosSize() {
        // ALWAYS save the position, regardless of whether it is minimized or expanded
        mainWidget.style.right = 'auto';
        mainWidget.style.bottom = 'auto';
        notepadWrapper.style.right = 'auto';
        notepadWrapper.style.bottom = 'auto';
        
        GM_setValue('main_pos', { 
            left: mainWidget.style.left, 
            top: mainWidget.style.top 
        });
        GM_setValue('note_pos', { 
            left: notepadWrapper.style.left, 
            top: notepadWrapper.style.top 
        });
        
        // ONLY save the sizes if the window is expanded
        if (isMinimized === false) {
            mainSize = { 
                width: mainWidget.style.width, 
                height: mainWidget.style.height 
            };
            GM_setValue('main_size', mainSize);
        }
        
        noteSize = { 
            width: notepadWrapper.style.width, 
            height: notepadWrapper.style.height 
        };
        GM_setValue('note_size', noteSize);
    }

    // ==========================================
    // 7. LIVE RESIZE OBSERVER (COUPLED SCALING)
    // ==========================================
    
    // We use this flag to prevent infinite loops when the script resizes the other window programmatically
    let isSyncingSize = false;
    
    // Parse the previous sizes safely to track how many pixels the user dragged
    let lastMainW = parseInt(mainSize.width, 10);
    if (isNaN(lastMainW) === true) {
        lastMainW = 270;
    }
    
    let lastMainH = parseInt(mainSize.height, 10);
    if (isNaN(lastMainH) === true) {
        lastMainH = 400;
    }
    
    let lastNoteW = parseInt(noteSize.width, 10);
    if (isNaN(lastNoteW) === true) {
        lastNoteW = 240;
    }
    
    let lastNoteH = parseInt(noteSize.height, 10);
    if (isNaN(lastNoteH) === true) {
        lastNoteH = 400;
    }

    const resizeObserver = new ResizeObserver(function(entries) {
        if (isSyncingSize === true) {
            return;
        }

        let deltaW = 0;
        let deltaH = 0;
        let activeTarget = null;

        for (let entry of entries) {
            if (entry.target.offsetWidth > 50) { 
                
                if (entry.target === mainWidget) {
                    let newW = entry.target.offsetWidth;
                    let newH = entry.target.offsetHeight;
                    
                    if (newW !== lastMainW || newH !== lastMainH) {
                        deltaW = newW - lastMainW;
                        deltaH = newH - lastMainH;
                        
                        lastMainW = newW;
                        lastMainH = newH;
                        
                        if (mainWInput !== undefined) {
                            mainWInput.value = newW;
                            mainHInput.value = newH;
                        }
                        
                        mainSize = { width: newW + 'px', height: newH + 'px' };
                        GM_setValue('main_size', mainSize);
                        
                        activeTarget = 'main';
                    }
                } 
                
                else if (entry.target === notepadWrapper) {
                    let newW = entry.target.offsetWidth;
                    let newH = entry.target.offsetHeight;
                    
                    if (newW !== lastNoteW || newH !== lastNoteH) {
                        deltaW = newW - lastNoteW;
                        deltaH = newH - lastNoteH;
                        
                        lastNoteW = newW;
                        lastNoteH = newH;
                        
                        if (noteWInput !== undefined) {
                            noteWInput.value = newW;
                            noteHInput.value = newH;
                        }
                        
                        noteSize = { width: newW + 'px', height: newH + 'px' };
                        GM_setValue('note_size', noteSize);
                        
                        activeTarget = 'note';
                    }
                }
            }
        }

        if (isCoupled === true && isNotepadOpen === true && isMinimized === false && activeTarget !== null) {
            isSyncingSize = true;
            
            if (activeTarget === 'main') {
                lastNoteW = lastNoteW + deltaW;
                lastNoteH = lastNoteH + deltaH;
                
                if (lastNoteW < 150) { 
                    lastNoteW = 150; 
                }
                if (lastNoteH < 150) { 
                    lastNoteH = 150; 
                }

                notepadWrapper.style.width = lastNoteW + 'px';
                notepadWrapper.style.height = lastNoteH + 'px';
                
                if (noteWInput !== undefined) {
                    noteWInput.value = lastNoteW;
                    noteHInput.value = lastNoteH;
                }
                
                noteSize = { width: lastNoteW + 'px', height: lastNoteH + 'px' };
                GM_setValue('note_size', noteSize);
                
            } else if (activeTarget === 'note') {
                lastMainW = lastMainW + deltaW;
                lastMainH = lastMainH + deltaH;
                
                if (lastMainW < 200) { 
                    lastMainW = 200; 
                }
                if (lastMainH < 150) { 
                    lastMainH = 150; 
                }

                mainWidget.style.width = lastMainW + 'px';
                mainWidget.style.height = lastMainH + 'px';
                
                if (mainWInput !== undefined) {
                    mainWInput.value = lastMainW;
                    mainHInput.value = lastMainH;
                }
                
                mainSize = { width: lastMainW + 'px', height: lastMainH + 'px' };
                GM_setValue('main_size', mainSize);
            }
            
            setTimeout(function() {
                isSyncingSize = false;
            }, 50);
        }
    });

    // ==========================================
    // 8. EVENT INTERCEPTORS & COPY LOGIC
    // ==========================================

    async function copyImageToClipboard(imgSrc) {
        try { 
            const response = await fetch(imgSrc); 
            const blob = await response.blob(); 
            const item = new ClipboardItem({[blob.type]: blob});
            await navigator.clipboard.write([item]); 
            return true; 
        } catch (err) { 
            // Fallback if website blocks cross-origin downloading
            GM_setClipboard(`<img src="${imgSrc}">`, 'html'); 
            return false; 
        }
    }

    window.addEventListener('keydown', function(e) { 
        if (isDashboardOpen === true) {
            return;
        }

        if (e.key === settings.hotkey) { 
            if (isTriggerDown === false) { 
                isTriggerDown = true; 
                hasClickedWhileTriggerDown = false; 
            } 
            if (e.target && e.target.id === 'gcs-scratchpad-input') {
                e.preventDefault(); 
            }
        } 
    });
    
    window.addEventListener('keyup', function(e) { 
        if (isDashboardOpen === true) {
            return;
        }

        if (e.key === settings.hotkey) { 
            if (e.target && e.target.id === 'gcs-scratchpad-input' && hasClickedWhileTriggerDown === false) { 
                const start = e.target.selectionStart; 
                const end = e.target.selectionEnd;
                e.target.value = e.target.value.substring(0, start) + settings.hotkey + e.target.value.substring(end); 
                e.target.selectionStart = start + 1;
                e.target.selectionEnd = start + 1;
                e.target.dispatchEvent(new Event('input', { bubbles: true })); 
            } 
            isTriggerDown = false; 
            isCombining = false; 
        } 
        if (e.key === 'Control') {
            isCombining = false; 
        }
    });

    window.addEventListener('click', function(e) {
        if (isDashboardOpen === true) {
            return;
        }

        const isClickOutside = !mainWidget.contains(e.target) && !notepadWrapper.contains(e.target) && !dashboardOverlay.contains(e.target);
        
        if (settings.autoCollapse === true && isMinimized === false && isClickOutside === true) {
            const toggleBtn = document.getElementById('gcs-toggle-btn');
            if (toggleBtn !== null) {
                toggleBtn.click();
            }
        }

        if (isTriggerDown === true) {
            e.preventDefault(); 
            e.stopPropagation(); 
            hasClickedWhileTriggerDown = true; 
            
            let captured = null;
            
            if (e.target && e.target.id === 'gcs-scratchpad-input') {
                const start = e.target.selectionStart;
                const end = e.target.selectionEnd;
                const val = e.target.value;
                let text = '';
                
                if (start !== end) {
                    text = val.substring(start, end).trim();
                } else {
                    let lineStart = val.lastIndexOf('\n', start - 1);
                    if (lineStart === -1) {
                        lineStart = 0;
                    } else {
                        lineStart = lineStart + 1;
                    }
                    
                    let lineEnd = val.indexOf('\n', start);
                    if (lineEnd === -1) {
                        lineEnd = val.length;
                    }
                    
                    text = val.substring(lineStart, lineEnd).trim();
                }
                
                if (text !== '') {
                    captured = { type: 'text', text: text };
                }
            } else if (e.target && e.target.tagName.toLowerCase() === 'img') { 
                captured = { type: 'image', text: e.target.src };
            } else { 
                let text = window.getSelection().toString().trim(); 
                if (text === '') {
                    text = (e.target.innerText || e.target.textContent || '').trim(); 
                }
                if (text !== '') { 
                    const sentenceEndRegex = /(?<!\b(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|st|ave|rd|inc|ltd|co|corp))(?<!\b[A-Z])[.!?]+/i;
                    const match = text.match(sentenceEndRegex);
                    if (match !== null) {
                        text = text.substring(0, match.index + match[0].length).trim(); 
                    }
                    if (text !== '') {
                        captured = { type: 'text', text: text }; 
                    }
                } 
            }

            if (captured !== null) { 
                const isCtrlTextAppend = (e.ctrlKey === true && captured.type === 'text' && savedItems.length > 0 && savedItems[0].type === 'text');
                
                if (isCtrlTextAppend === true && isCombining === true) { 
                    savedItems[0].text = savedItems[0].text + '\n' + captured.text; 
                } else { 
                    savedItems.unshift(captured); 
                    if (e.ctrlKey === true) {
                        isCombining = false;
                    } else {
                        isCombining = true;
                    }
                }
                
                if (savedItems.length > settings.maxItems) {
                    savedItems = savedItems.slice(0, settings.maxItems);
                }
                
                GM_setValue('saved_clicks', savedItems); 
                pushToDesktop(); // Sync update
                
                if (captured.type === 'image') {
                    copyImageToClipboard(captured.text); 
                } else {
                    GM_setClipboard(savedItems[0].text, 'text'); 
                }
                
                window.getSelection().removeAllRanges(); 
                renderList(); 
            }
        }
    }, true);

    // ==========================================
    // 9. STYLES & THEMING
    // ==========================================

    const styleBlock = document.createElement('style');
    styleBlock.textContent = `
        :root { 
            --gcs-bg: #ffffff; 
            --gcs-header-bg: #f8f9fa; 
            --gcs-text: #333333; 
            --gcs-border: #cccccc; 
            --gcs-row-border: #f0f0f0; 
            --gcs-btn-bg: #e9ecef; 
            --gcs-btn-border: #bbbbbb; 
            --gcs-btn-text: #333333; 
            --gcs-controls-bg: #f1f3f5; 
            --gcs-success-bg: #d4edda; 
            --gcs-success-border: #c3e6cb; 
            --gcs-danger-bg: #ff6b6b; 
            --gcs-danger-text: #ffffff; 
            --gcs-note-bg: #fffbe6; 
            --gcs-note-border: #e8d65a; 
            --gcs-note-text: #333333; 
            --gcs-note-tab-bg: #f4edd0; 
            --gcs-font-size: ${settings.fontSize}; 
        }
        .gcs-dark-mode { 
            --gcs-bg: #2b2b2b; 
            --gcs-header-bg: #1e1e1e; 
            --gcs-text: #c0c0c0; 
            --gcs-border: #111111; 
            --gcs-row-border: #3a3a3a; 
            --gcs-btn-bg: #003666; 
            --gcs-btn-border: #002244; 
            --gcs-btn-text: #3399ff; 
            --gcs-controls-bg: #222222; 
            --gcs-success-bg: #005522; 
            --gcs-success-border: #007733; 
            --gcs-danger-bg: #8b0000; 
            --gcs-danger-text: #ffcccc; 
            --gcs-note-bg: #3b3721; 
            --gcs-note-border: #635c2b; 
            --gcs-note-text: #e0e0e0; 
            --gcs-note-tab-bg: #2d2a19; 
        }
        .gcs-floating-widget { 
            font-family: Arial, sans-serif; 
            font-size: var(--gcs-font-size); 
            box-sizing: border-box; 
            z-index: 2147483646; 
        }
        .gcs-floating-widget * { 
            box-sizing: border-box; 
        }
        .gcs-floating-widget select, 
        .gcs-floating-widget input[type="text"], 
        .gcs-floating-widget input[type="number"] { 
            background-color: var(--gcs-bg); 
            color: var(--gcs-text); 
            border: 1px solid var(--gcs-border); 
            border-radius: 3px; 
            padding: 2px 4px; 
            font-size: 11px;
        }
        .gcs-floating-widget button { 
            font-size: 11px;
        }
        .gcs-floating-widget button:hover { 
            filter: brightness(1.1); 
        }
        .gcs-settings-panel button:active { 
            filter: brightness(0.9); 
        }
        .gcs-tab:hover { 
            filter: brightness(1.1); 
        }
        #gcs-tab-bar::-webkit-scrollbar, 
        .gcs-list-scroll::-webkit-scrollbar, 
        .gcs-settings-panel::-webkit-scrollbar, 
        #gcs-scratchpad-input::-webkit-scrollbar { 
            width: 6px; 
            height: 6px; 
        }
        #gcs-tab-bar::-webkit-scrollbar-track, 
        .gcs-list-scroll::-webkit-scrollbar-track, 
        .gcs-settings-panel::-webkit-scrollbar-track, 
        #gcs-scratchpad-input::-webkit-scrollbar-track { 
            background: transparent; 
        }
        #gcs-tab-bar::-webkit-scrollbar-thumb, 
        .gcs-list-scroll::-webkit-scrollbar-thumb, 
        .gcs-settings-panel::-webkit-scrollbar-thumb, 
        #gcs-scratchpad-input::-webkit-scrollbar-thumb { 
            background: rgba(0,0,0,0.2); 
            border-radius: 4px; 
        }

        /* --- Live Dashboard Overlay Styles --- */
        #gcs-live-dashboard {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: var(--gcs-bg);
            z-index: 2147483647;
            overflow-y: auto;
            font-family: Arial, sans-serif;
            box-sizing: border-box;
        }
        #gcs-live-dashboard * {
            box-sizing: border-box;
        }
        .gcs-dash-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px;
            background-color: var(--gcs-header-bg);
            border-bottom: 1px solid var(--gcs-border);
            color: var(--gcs-text);
        }
        .gcs-dash-header h1 {
            margin: 0;
            font-size: 24px;
        }
        .gcs-dash-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            padding: 20px;
            align-items: flex-start;
        }
        .gcs-dash-card {
            display: flex;
            flex-direction: column;
            width: 300px;
            height: 300px;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            border: 1px solid var(--gcs-border);
            transition: transform 0.1s;
        }
        .gcs-dash-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            border-bottom: 1px solid rgba(0,0,0,0.1);
            user-select: none;
        }
        .gcs-dash-card-title {
            font-weight: bold;
            font-size: 14px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: grab;
        }
        .gcs-dash-card-title:active {
            cursor: grabbing;
        }
        .gcs-dash-card-body {
            flex-grow: 1;
            padding: 10px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .gcs-dash-textarea {
            width: 100%;
            height: 100%;
            border: none;
            background: transparent;
            resize: none;
            outline: none;
            font-family: inherit;
            font-size: 14px;
        }
        .gcs-dash-image-container {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .gcs-dash-image {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }
        .gcs-dash-btn {
            cursor: pointer;
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            background-color: var(--gcs-btn-bg);
            color: var(--gcs-btn-text);
            font-weight: bold;
            font-size: 14px;
            border: 1px solid var(--gcs-btn-border);
        }
        .gcs-dash-btn:hover {
            filter: brightness(1.1);
        }
        .gcs-dash-btn-danger {
            background-color: var(--gcs-danger-bg);
            color: var(--gcs-danger-text);
            border: 1px solid var(--gcs-danger-bg);
        }
    `;
    document.head.appendChild(styleBlock);
    
    if (isDarkMode === true) {
        document.documentElement.classList.add('gcs-dark-mode');
    }

    // ==========================================
    // 10. UI CONSTRUCTION: NOTEPAD
    // ==========================================

    notepadWrapper.style.position = 'fixed';
    notepadWrapper.style.left = notePos.left;
    notepadWrapper.style.top = notePos.top;
    notepadWrapper.style.right = notePos.right;
    notepadWrapper.style.bottom = notePos.bottom;
    notepadWrapper.style.width = noteSize.width;
    notepadWrapper.style.height = noteSize.height;
    notepadWrapper.style.minWidth = '150px';
    notepadWrapper.style.minHeight = '150px';
    notepadWrapper.style.backgroundColor = 'var(--gcs-note-bg)';
    notepadWrapper.style.border = '1px solid var(--gcs-note-border)';
    notepadWrapper.style.borderRadius = '6px';
    notepadWrapper.style.boxShadow = '0 6px 12px rgba(0,0,0,0.4)';
    
    if (isNotepadOpen === true && isMinimized === false) {
        notepadWrapper.style.display = 'flex';
    } else {
        notepadWrapper.style.display = 'none';
    }
    
    notepadWrapper.style.flexDirection = 'column';
    notepadWrapper.style.overflow = 'hidden';
    notepadWrapper.style.transition = 'background-color 0.2s';
    notepadWrapper.style.resize = 'both';

    const notepadHeader = document.createElement('div'); 
    notepadHeader.textContent = 'Scratchpad';
    notepadHeader.style.padding = '4px 10px';
    notepadHeader.style.backgroundColor = 'rgba(0,0,0,0.1)';
    notepadHeader.style.fontWeight = 'bold';
    notepadHeader.style.fontSize = '11px';
    notepadHeader.style.color = 'var(--gcs-note-text)';
    notepadHeader.style.cursor = 'move';
    notepadHeader.style.userSelect = 'none';
    notepadHeader.style.textAlign = 'center';
    notepadHeader.style.flexShrink = '0';

    const tabBar = document.createElement('div'); 
    tabBar.style.display = 'flex';
    tabBar.style.overflowX = 'auto';
    tabBar.style.backgroundColor = 'var(--gcs-note-tab-bg)';
    tabBar.style.borderBottom = '1px solid var(--gcs-note-border)';
    tabBar.style.flexShrink = '0';

    const notepadInput = document.createElement('textarea'); 
    notepadInput.id = 'gcs-scratchpad-input';
    notepadInput.style.flexGrow = '1';
    notepadInput.style.border = 'none';
    notepadInput.style.background = 'transparent';
    notepadInput.style.resize = 'none';
    notepadInput.style.padding = '8px';
    notepadInput.style.fontSize = '12px';
    notepadInput.style.outline = 'none';
    notepadInput.style.fontFamily = 'inherit';
    notepadInput.style.lineHeight = '1.4';

    const imageViewer = document.createElement('div'); 
    imageViewer.style.flexGrow = '1';
    imageViewer.style.display = 'none';
    imageViewer.style.flexDirection = 'column';
    imageViewer.style.alignItems = 'center';
    imageViewer.style.justifyContent = 'center';
    imageViewer.style.padding = '10px';

    notepadInput.addEventListener('input', function(e) { 
        const tab = notepadTabs.find(function(t) {
            return t.id === activeTabId;
        }); 
        if (tab !== undefined && tab.type === 'text') { 
            tab.text = e.target.value; 
            GM_setValue('notepad_tabs', notepadTabs); 
            pushToDesktop(); // Sync update
            
            if (isDashboardOpen === true) {
                renderLiveDashboard();
            }
        } 
    });

    notepadWrapper.appendChild(notepadHeader);
    notepadWrapper.appendChild(tabBar);
    notepadWrapper.appendChild(notepadInput);
    notepadWrapper.appendChild(imageViewer);
    makeDraggable(notepadHeader, notepadWrapper);

    // ==========================================
    // 11. UI CONSTRUCTION: MAIN WIDGET
    // ==========================================

    mainWidget.style.position = 'fixed';
    mainWidget.style.left = mainPos.left;
    mainWidget.style.top = mainPos.top;
    mainWidget.style.right = mainPos.right;
    mainWidget.style.bottom = mainPos.bottom;
    mainWidget.style.width = mainSize.width;
    if (isMinimized === true) {
        mainWidget.style.height = 'auto';
    } else {
        mainWidget.style.height = mainSize.height;
    }
    mainWidget.style.minWidth = '200px';
    if (isMinimized === true) {
        mainWidget.style.minHeight = '0px';
    } else {
        mainWidget.style.minHeight = '150px';
    }
    mainWidget.style.backgroundColor = 'var(--gcs-bg)';
    mainWidget.style.border = '1px solid var(--gcs-border)';
    mainWidget.style.boxShadow = '0 6px 12px rgba(0,0,0,0.4)';
    mainWidget.style.color = 'var(--gcs-text)';
    mainWidget.style.borderRadius = '6px';
    mainWidget.style.display = 'flex';
    mainWidget.style.flexDirection = 'column';
    mainWidget.style.overflow = 'hidden';
    if (isMinimized === true) {
        mainWidget.style.resize = 'none';
    } else {
        mainWidget.style.resize = 'both';
    }

    const header = document.createElement('div'); 
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.padding = '8px 10px';
    header.style.backgroundColor = 'var(--gcs-header-bg)';
    header.style.borderBottom = '1px solid var(--gcs-border)';
    header.style.cursor = 'move';
    header.style.userSelect = 'none';
    header.style.flexShrink = '0';

    const titleElement = document.createElement('strong'); 
    titleElement.textContent = settings.widgetTitle; 
    header.appendChild(titleElement);

    const headerControls = document.createElement('div');
    
    // Ordered strictly: Gear, Page, Magnet, Reset, Minimize
    const settingsBtn = document.createElement('button'); 
    settingsBtn.textContent = '⚙️'; 
    settingsBtn.title = 'Settings';
    
    const noteToggleBtn = document.createElement('button'); 
    noteToggleBtn.textContent = '📝'; 
    noteToggleBtn.title = 'Toggle Scratchpad'; 
    if (isNotepadOpen === true) {
        noteToggleBtn.style.opacity = '1';
    } else {
        noteToggleBtn.style.opacity = '0.4';
    }

    const magnetBtn = document.createElement('button'); 
    magnetBtn.textContent = '🧲'; 
    magnetBtn.title = 'Couple Windows'; 
    if (isCoupled === true) {
        magnetBtn.style.opacity = '1';
    } else {
        magnetBtn.style.opacity = '0.4';
    }
    
    const resetBtn = document.createElement('button'); 
    resetBtn.textContent = '🔄'; 
    resetBtn.title = 'Reset to Default Config';
    
    const toggleBtn = document.createElement('button'); 
    toggleBtn.id = 'gcs-toggle-btn';
    if (isMinimized === true) {
        toggleBtn.textContent = '+';
    } else {
        toggleBtn.textContent = '−';
    }
    toggleBtn.title = 'Toggle Size';
    
    const controlButtons = [settingsBtn, noteToggleBtn, magnetBtn, resetBtn, toggleBtn];
    
    controlButtons.forEach(function(btn) {
        btn.style.cursor = 'pointer';
        btn.style.background = 'none';
        btn.style.border = 'none';
        btn.style.marginLeft = '4px'; 
        btn.style.fontSize = '14px';
        btn.style.padding = '2px';
    });
    
    if (isMinimized === true) {
        settingsBtn.style.display = 'none';
        noteToggleBtn.style.display = 'none';
        magnetBtn.style.display = 'none';
        resetBtn.style.display = 'none';
    }
    
    headerControls.appendChild(settingsBtn);
    headerControls.appendChild(noteToggleBtn);
    headerControls.appendChild(magnetBtn);
    headerControls.appendChild(resetBtn);
    headerControls.appendChild(toggleBtn);
    
    header.appendChild(headerControls); 
    mainWidget.appendChild(header);

    // ==========================================
    // 12. SETTINGS PANEL
    // ==========================================

    const settingsPanel = document.createElement('div');
    settingsPanel.style.display = 'none';
    settingsPanel.style.padding = '10px';
    settingsPanel.style.backgroundColor = 'var(--gcs-controls-bg)';
    settingsPanel.style.borderBottom = '1px solid var(--gcs-border)';
    settingsPanel.style.fontSize = '11px';
    settingsPanel.style.flexShrink = '0';
    settingsPanel.style.flexDirection = 'column';
    settingsPanel.style.gap = '8px';
    settingsPanel.style.overflowY = 'auto';
    settingsPanel.style.maxHeight = '250px';

    mainWidget.appendChild(settingsPanel);

    function createRow(labelTxt, el) { 
        const row = document.createElement('div'); 
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        
        const lbl = document.createElement('span'); 
        lbl.textContent = labelTxt; 
        
        row.appendChild(lbl);
        row.appendChild(el); 
        return row; 
    }

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = settings.widgetTitle;
    titleInput.style.width = '100px';
    titleInput.addEventListener('change', function(e) {
        if (e.target.value !== '') {
            settings.widgetTitle = e.target.value;
        } else {
            settings.widgetTitle = 'Saved Items';
        }
        GM_setValue('gcs_settings', settings);
        pushToDesktop(); // Sync update
        titleElement.textContent = settings.widgetTitle;
    });

    const hotkeyInput = document.createElement('input'); 
    hotkeyInput.type = 'text'; 
    hotkeyInput.value = settings.hotkey; 
    hotkeyInput.maxLength = 1; 
    hotkeyInput.style.width = '30px'; 
    hotkeyInput.style.textAlign = 'center';
    hotkeyInput.addEventListener('change', function(e) { 
        if (e.target.value !== '') {
            settings.hotkey = e.target.value;
        } else {
            settings.hotkey = '`';
        }
        GM_setValue('gcs_settings', settings); 
        pushToDesktop(); // Sync update
    });
    
    const fsInput = document.createElement('input'); 
    fsInput.type = 'number'; 
    fsInput.min = 10; 
    fsInput.max = 30; 
    fsInput.value = parseInt(settings.fontSize, 10); 
    fsInput.style.width = '40px';
    fsInput.addEventListener('change', function(e) { 
        settings.fontSize = e.target.value + 'px'; 
        GM_setValue('gcs_settings', settings); 
        pushToDesktop(); // Sync update
        styleBlock.textContent = styleBlock.textContent.replace(/--gcs-font-size: \d+px;/g, `--gcs-font-size: ${settings.fontSize};`); 
    });
    
    const keepInput = document.createElement('select'); 
    const keepValues = [5, 10, 20, 50];
    keepValues.forEach(function(v) { 
        const o = document.createElement('option'); 
        o.value = v; 
        o.textContent = v; 
        if (v === settings.maxItems) {
            o.selected = true; 
        }
        keepInput.appendChild(o); 
    });
    keepInput.addEventListener('change', function(e) { 
        settings.maxItems = parseInt(e.target.value, 10); 
        GM_setValue('gcs_settings', settings); 
        if (savedItems.length > settings.maxItems) { 
            savedItems = savedItems.slice(0, settings.maxItems); 
            GM_setValue('saved_clicks', savedItems); 
            renderList(); 
        } 
        pushToDesktop(); // Sync update
    });
    
    const collapseCb = document.createElement('input'); 
    collapseCb.type = 'checkbox'; 
    collapseCb.checked = settings.autoCollapse;
    collapseCb.addEventListener('change', function(e) { 
        settings.autoCollapse = e.target.checked; 
        GM_setValue('gcs_settings', settings); 
        pushToDesktop(); // Sync update
    });

    const askClearCb = document.createElement('input'); 
    askClearCb.type = 'checkbox'; 
    askClearCb.checked = settings.askBeforeClear;
    askClearCb.addEventListener('change', function(e) { 
        settings.askBeforeClear = e.target.checked; 
        GM_setValue('gcs_settings', settings); 
        pushToDesktop(); // Sync update
    });
    
    const darkModeCb = document.createElement('input'); 
    darkModeCb.type = 'checkbox'; 
    darkModeCb.checked = isDarkMode;
    darkModeCb.addEventListener('change', function(e) { 
        isDarkMode = !isDarkMode; 
        GM_setValue('is_dark_mode', isDarkMode); 
        if (isDarkMode === true) {
            document.documentElement.classList.add('gcs-dark-mode');
        } else {
            document.documentElement.classList.remove('gcs-dark-mode');
        }
        darkModeCb.checked = isDarkMode; 
        
        // Pass theme changes up to the desktop object
        settings.isDarkMode = isDarkMode;
        GM_setValue('gcs_settings', settings);
        pushToDesktop();
        
        if (isDashboardOpen === true) {
            renderLiveDashboard();
        }
    });
    
    function createSizeGroup(wInp, hInp) { 
        const wrap = document.createElement('div'); 
        wrap.style.display = 'flex'; 
        wrap.style.gap = '4px'; 
        wrap.style.alignItems = 'center'; 
        const wL = document.createElement('span'); 
        wL.textContent = 'W:'; 
        const hL = document.createElement('span'); 
        hL.textContent = 'H:'; 
        wrap.appendChild(wL);
        wrap.appendChild(wInp);
        wrap.appendChild(hL);
        wrap.appendChild(hInp); 
        return wrap; 
    }

    mainWInput = document.createElement('input'); 
    mainWInput.type = 'number'; 
    mainWInput.style.width = '45px'; 
    mainWInput.value = parseInt(mainSize.width);
    
    mainHInput = document.createElement('input'); 
    mainHInput.type = 'number'; 
    mainHInput.style.width = '45px'; 
    mainHInput.value = parseInt(mainSize.height);
    
    mainWInput.addEventListener('change', function(e) { 
        mainWidget.style.width = e.target.value + 'px'; 
        savePosSize(); 
    });
    mainHInput.addEventListener('change', function(e) { 
        mainWidget.style.height = e.target.value + 'px'; 
        savePosSize(); 
    });
    
    noteWInput = document.createElement('input'); 
    noteWInput.type = 'number'; 
    noteWInput.style.width = '45px'; 
    noteWInput.value = parseInt(noteSize.width);
    
    noteHInput = document.createElement('input'); 
    noteHInput.type = 'number'; 
    noteHInput.style.width = '45px'; 
    noteHInput.value = parseInt(noteSize.height);
    
    noteWInput.addEventListener('change', function(e) { 
        notepadWrapper.style.width = e.target.value + 'px'; 
        savePosSize(); 
    });
    noteHInput.addEventListener('change', function(e) { 
        notepadWrapper.style.height = e.target.value + 'px'; 
        savePosSize(); 
    });

    const defaultsBtn = document.createElement('button'); 
    defaultsBtn.textContent = 'Save Current Layout as Default'; 
    defaultsBtn.style.cursor = 'pointer';
    defaultsBtn.style.padding = '4px 8px';
    defaultsBtn.style.marginTop = '6px';
    defaultsBtn.style.width = '100%';
    defaultsBtn.style.backgroundColor = 'var(--gcs-btn-bg)';
    defaultsBtn.style.border = '1px solid var(--gcs-btn-border)';
    defaultsBtn.style.color = 'var(--gcs-btn-text)';
    defaultsBtn.style.borderRadius = '4px';

    defaultsBtn.addEventListener('click', function() { 
        const layoutConfig = { 
            mainPos: { left: mainWidget.style.left, top: mainWidget.style.top }, 
            notePos: { left: notepadWrapper.style.left, top: notepadWrapper.style.top }, 
            mainSize: GM_getValue('main_size'), 
            noteSize: GM_getValue('note_size'), 
            fontSize: settings.fontSize, 
            darkMode: isDarkMode 
        };
        GM_setValue('default_gcs_config', layoutConfig); 
        defaultsBtn.textContent = 'Configuration Saved!'; 
        setTimeout(function() {
            defaultsBtn.textContent = 'Save Current Layout as Default';
        }, 1500); 
    });
    
    // Tools Row
    const toolsRow1 = document.createElement('div'); 
    toolsRow1.style.display = 'flex';
    toolsRow1.style.justifyContent = 'space-around';
    toolsRow1.style.gap = '4px';
    toolsRow1.style.marginTop = '4px';

    const toolsRow2 = document.createElement('div'); 
    toolsRow2.style.display = 'flex';
    toolsRow2.style.justifyContent = 'space-around';
    toolsRow2.style.gap = '4px';
    toolsRow2.style.marginTop = '4px';

    const backupBtn = document.createElement('button'); 
    backupBtn.textContent = '💾 Backup'; 
    backupBtn.style.cursor = 'pointer';
    backupBtn.style.padding = '4px';
    backupBtn.style.flexGrow = '1';
    backupBtn.style.borderRadius = '4px';
    backupBtn.style.border = '1px solid var(--gcs-border)';
    
    backupBtn.addEventListener('click', function() { 
        const a = document.createElement('a'); 
        const dataStr = JSON.stringify({ savedItems: savedItems, notepadTabs: notepadTabs, settings: settings });
        a.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(dataStr); 
        a.download = 'gcs_backup.json'; 
        a.click(); 
    });

    const restoreBtn = document.createElement('button'); 
    restoreBtn.textContent = '📂 Import'; 
    restoreBtn.style.cursor = 'pointer';
    restoreBtn.style.padding = '4px';
    restoreBtn.style.flexGrow = '1';
    restoreBtn.style.borderRadius = '4px';
    restoreBtn.style.border = '1px solid var(--gcs-border)';
    
    const rf = document.createElement('input'); 
    rf.type = 'file'; 
    rf.accept = '.json'; 
    rf.style.display = 'none'; 
    
    restoreBtn.addEventListener('click', function() {
        rf.click();
    });
    
    rf.addEventListener('change', function(e) { 
        const reader = new FileReader(); 
        reader.addEventListener('load', function(event) { 
            try { 
                const data = JSON.parse(event.target.result); 
                if (data.savedItems !== undefined) {
                    savedItems = data.savedItems;
                }
                if (data.notepadTabs !== undefined) {
                    notepadTabs = data.notepadTabs;
                }
                if (data.settings !== undefined) {
                    settings = data.settings;
                }
                
                GM_setValue('saved_clicks', savedItems); 
                GM_setValue('notepad_tabs', notepadTabs); 
                GM_setValue('gcs_settings', settings); 
                
                pushToDesktop(); // Sync update
                
                alert('Import success, reloading...'); 
                location.reload(); 
            } catch (err) { 
                alert('Invalid file format.'); 
            } 
        }); 
        reader.readAsText(e.target.files[0]); 
    });

    const staticWebBtn = document.createElement('button'); 
    staticWebBtn.textContent = '🌐 Static Export'; 
    staticWebBtn.style.cursor = 'pointer';
    staticWebBtn.style.padding = '4px';
    staticWebBtn.style.flexGrow = '1';
    staticWebBtn.style.borderRadius = '4px';
    staticWebBtn.style.border = '1px solid var(--gcs-border)';
    staticWebBtn.addEventListener('click', generateStaticDashboard);

    const liveWebBtn = document.createElement('button'); 
    liveWebBtn.textContent = '🖥️ Live Dashboard'; 
    liveWebBtn.style.cursor = 'pointer';
    liveWebBtn.style.padding = '4px';
    liveWebBtn.style.flexGrow = '1';
    liveWebBtn.style.borderRadius = '4px';
    liveWebBtn.style.border = '1px solid var(--gcs-border)';
    liveWebBtn.style.backgroundColor = 'var(--gcs-btn-bg)';
    liveWebBtn.style.fontWeight = 'bold';
    liveWebBtn.addEventListener('click', function() {
        isDashboardOpen = true;
        dashboardOverlay.style.display = 'block';
        renderLiveDashboard();
    });
    
    toolsRow1.appendChild(backupBtn);
    toolsRow1.appendChild(restoreBtn);
    toolsRow1.appendChild(rf);
    
    toolsRow2.appendChild(staticWebBtn);
    toolsRow2.appendChild(liveWebBtn);

    settingsPanel.appendChild(createRow('Widget Title:', titleInput));
    settingsPanel.appendChild(createRow('Trigger Key:', hotkeyInput));
    settingsPanel.appendChild(createRow('Font Size:', fsInput));
    settingsPanel.appendChild(createRow('Ask Before Clearing:', askClearCb));
    settingsPanel.appendChild(createRow('Keep Items:', keepInput));
    settingsPanel.appendChild(createRow('Dark Mode:', darkModeCb));
    settingsPanel.appendChild(createRow('Auto-Collapse:', collapseCb));
    settingsPanel.appendChild(createRow('List Size:', createSizeGroup(mainWInput, mainHInput)));
    settingsPanel.appendChild(createRow('Note Size:', createSizeGroup(noteWInput, noteHInput)));
    settingsPanel.appendChild(defaultsBtn);
    settingsPanel.appendChild(toolsRow1);
    settingsPanel.appendChild(toolsRow2);

    // ==========================================
    // 13. LIST ACTION ROW (CLEAR BUTTONS)
    // ==========================================

    const listActionsRow = document.createElement('div');
    listActionsRow.style.display = 'flex';
    listActionsRow.style.justifyContent = 'space-between';
    listActionsRow.style.padding = '8px';
    listActionsRow.style.backgroundColor = 'var(--gcs-controls-bg)';
    listActionsRow.style.borderBottom = '1px solid var(--gcs-border)';
    if (isMinimized === true) {
        listActionsRow.style.display = 'none';
    }

    const clearItemsBtn = document.createElement('button');
    clearItemsBtn.textContent = '🗑️ Clear All Items';
    clearItemsBtn.style.cursor = 'pointer';
    clearItemsBtn.style.padding = '4px 8px';
    clearItemsBtn.style.backgroundColor = 'var(--gcs-danger-bg)';
    clearItemsBtn.style.color = 'var(--gcs-danger-text)';
    clearItemsBtn.style.border = 'none';
    clearItemsBtn.style.borderRadius = '4px';
    clearItemsBtn.style.fontWeight = 'bold';

    clearItemsBtn.addEventListener('click', function() {
        if (settings.askBeforeClear === true) {
            if (confirm('Are you sure you want to delete all saved items?') === false) {
                return;
            }
        }
        savedItems = [];
        GM_setValue('saved_clicks', savedItems);
        renderList();
        pushToDesktop(); // Sync update
    });

    const clearNoteBtn = document.createElement('button');
    clearNoteBtn.textContent = '🗑️ Clear Notepad';
    clearNoteBtn.style.cursor = 'pointer';
    clearNoteBtn.style.padding = '4px 8px';
    clearNoteBtn.style.backgroundColor = 'var(--gcs-btn-bg)';
    clearNoteBtn.style.color = 'var(--gcs-btn-text)';
    clearNoteBtn.style.border = '1px solid var(--gcs-btn-border)';
    clearNoteBtn.style.borderRadius = '4px';
    clearNoteBtn.style.fontWeight = 'bold';

    clearNoteBtn.addEventListener('click', function() {
        if (settings.askBeforeClear === true) {
            if (confirm('Are you sure you want to wipe the active notepad?') === false) {
                return;
            }
        }
        let activeTab = notepadTabs.find(function(t) { 
            return t.id === activeTabId; 
        });
        
        if (activeTab !== undefined) {
            activeTab.text = '';
            if (activeTab.type === 'image') {
                activeTab.type = 'text'; // Revert to a normal text note upon clear
            }
            GM_setValue('notepad_tabs', notepadTabs);
            renderTabs();
            pushToDesktop(); // Sync update
            
            if (isDashboardOpen === true) {
                renderLiveDashboard();
            }
        }
    });

    listActionsRow.appendChild(clearItemsBtn);
    listActionsRow.appendChild(clearNoteBtn);
    mainWidget.appendChild(listActionsRow);

    // List Container
    const listContainer = document.createElement('div'); 
    listContainer.className = 'gcs-list-scroll';
    if (isMinimized === true) {
        listContainer.style.display = 'none';
    } else {
        listContainer.style.display = 'block';
    }
    listContainer.style.padding = '8px';
    listContainer.style.overflowY = 'auto';
    listContainer.style.flexGrow = '1';
    
    mainWidget.appendChild(listContainer);
    
    document.body.appendChild(notepadWrapper);
    document.body.appendChild(mainWidget);
    document.body.appendChild(dashboardOverlay);
    makeDraggable(header, mainWidget);

    // Ensure the window renders within bounds on fresh load
    setTimeout(function() {
        const rect = mainWidget.getBoundingClientRect();
        const isOffScreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
        
        if (isOffScreen === true) {
            mainWidget.style.left = defaultMainPos.left;
            mainWidget.style.top = defaultMainPos.top;
            mainWidget.style.right = defaultMainPos.right;
            mainWidget.style.bottom = defaultMainPos.bottom;
            savePosSize();
        }
    }, 500);

    // ==========================================
    // 14. DRAG AND DROP TABS LOGIC
    // ==========================================

    function handleTabDragStart(e, tabId) {
        draggedTabId = tabId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tabId);
    }

    function handleTabDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }

    function handleTabDrop(e, targetTabId) {
        e.preventDefault();
        
        if (draggedTabId !== null && draggedTabId !== targetTabId) {
            const draggedIndex = notepadTabs.findIndex(function(t) { return t.id === draggedTabId; });
            const targetIndex = notepadTabs.findIndex(function(t) { return t.id === targetTabId; });
            
            if (draggedIndex !== -1 && targetIndex !== -1) {
                // Remove the dragged tab from the array
                const tabToMove = notepadTabs.splice(draggedIndex, 1)[0];
                // Insert it at the new target position
                notepadTabs.splice(targetIndex, 0, tabToMove);
                
                GM_setValue('notepad_tabs', notepadTabs);
                renderTabs();
                pushToDesktop(); // Sync update
                
                if (isDashboardOpen === true) {
                    renderLiveDashboard();
                }
            }
        }
        draggedTabId = null;
    }

    function handleTabDragEnd(e) {
        draggedTabId = null;
    }

    // ==========================================
    // 15. LIVE OVERLAY DASHBOARD LOGIC
    // ==========================================

    function renderLiveDashboard() {
        // Prevent scroll on the main website body while dashboard is open
        document.body.style.overflow = 'hidden';
        
        dashboardOverlay.innerHTML = '';
        
        const headerRow = document.createElement('div');
        headerRow.className = 'gcs-dash-header';
        
        const titleSpan = document.createElement('h1');
        titleSpan.textContent = settings.widgetTitle + ' - Live Dashboard';
        
        const rightControls = document.createElement('div');
        
        const addDashBtn = document.createElement('button');
        addDashBtn.className = 'gcs-dash-btn';
        addDashBtn.textContent = '+ Add Note';
        addDashBtn.addEventListener('click', function() {
            const newId = Date.now(); 
            notepadTabs.push({ 
                id: newId, 
                title: `Note ${notepadTabs.length + 1}`, 
                text: '', 
                type: 'text', 
                color: '', 
                textColor: '' 
            }); 
            activeTabId = newId; 
            GM_setValue('notepad_tabs', notepadTabs); 
            GM_setValue('active_tab_id', activeTabId); 
            renderTabs(); 
            pushToDesktop(); // Sync update
            renderLiveDashboard();
        });

        const dashClearItemsBtn = document.createElement('button');
        dashClearItemsBtn.className = 'gcs-dash-btn';
        dashClearItemsBtn.textContent = '🗑️ Clear All Items';
        dashClearItemsBtn.style.marginLeft = '15px';
        dashClearItemsBtn.addEventListener('click', function() {
            if (settings.askBeforeClear === true) {
                if (confirm('Are you sure you want to delete all saved items?') === false) {
                    return;
                }
            }
            savedItems = [];
            GM_setValue('saved_clicks', savedItems);
            renderList();
            pushToDesktop(); // Sync update
        });

        const dashClearNotesBtn = document.createElement('button');
        dashClearNotesBtn.className = 'gcs-dash-btn';
        dashClearNotesBtn.textContent = '🗑️ Clear All Notes';
        dashClearNotesBtn.style.marginLeft = '15px';
        dashClearNotesBtn.addEventListener('click', function() {
            if (settings.askBeforeClear === true) {
                if (confirm('Are you sure you want to WIPE ALL NOTEPADS entirely?') === false) {
                    return;
                }
            }
            notepadTabs.forEach(function(t) {
                t.text = '';
                if (t.type === 'image') {
                    t.type = 'text'; // Revert back to plain text
                }
            });
            GM_setValue('notepad_tabs', notepadTabs);
            renderTabs();
            pushToDesktop(); // Sync update
            renderLiveDashboard();
        });
        
        const closeDashBtn = document.createElement('button');
        closeDashBtn.className = 'gcs-dash-btn gcs-dash-btn-close';
        closeDashBtn.textContent = '✖ Close Dashboard';
        closeDashBtn.style.marginLeft = '15px';
        closeDashBtn.addEventListener('click', function() {
            isDashboardOpen = false;
            dashboardOverlay.style.display = 'none';
            document.body.style.overflow = ''; // Restore website scroll
        });
        
        rightControls.appendChild(addDashBtn);
        rightControls.appendChild(dashClearItemsBtn);
        rightControls.appendChild(dashClearNotesBtn);
        rightControls.appendChild(closeDashBtn);
        
        headerRow.appendChild(titleSpan);
        headerRow.appendChild(rightControls);
        dashboardOverlay.appendChild(headerRow);
        
        const grid = document.createElement('div');
        grid.className = 'gcs-dash-grid';
        
        notepadTabs.forEach(function(t, i) {
            const card = document.createElement('div');
            card.className = 'gcs-dash-card';
            
            let bgColor = t.color;
            if (bgColor === '') {
                bgColor = (isDarkMode === true) ? '#3b3721' : '#fffbe6';
            }
            card.style.backgroundColor = bgColor;
            
            let txtColor = t.textColor;
            if (txtColor === '') {
                txtColor = (isDarkMode === true) ? '#e0e0e0' : '#333';
            }
            card.style.color = txtColor;
            
            const cardHeader = document.createElement('div');
            cardHeader.className = 'gcs-dash-card-header';
            
            // Allow dropping onto the header of the card for reordering
            cardHeader.addEventListener('dragover', handleTabDragOver);
            cardHeader.addEventListener('drop', function(e) {
                handleTabDrop(e, t.id);
            });
            
            const cardTitle = document.createElement('div');
            cardTitle.className = 'gcs-dash-card-title';
            
            let icon = '📝 ';
            if (t.type === 'image') {
                icon = '🖼️ ';
            }
            cardTitle.textContent = icon + t.title;
            
            // ONLY the title is draggable in the dashboard now
            cardTitle.draggable = true;
            cardTitle.style.cursor = 'grab';
            cardTitle.addEventListener('dragstart', function(e) {
                handleTabDragStart(e, t.id);
            });
            cardTitle.addEventListener('dragend', handleTabDragEnd);
            
            const cardControls = document.createElement('div');
            
            const bgBtn = document.createElement('span'); 
            bgBtn.textContent = '🎨'; 
            bgBtn.title = 'Background Color'; 
            bgBtn.style.cursor = 'pointer';
            bgBtn.style.marginLeft = '6px';
            bgBtn.style.fontSize = '12px';
            
            const bgInput = document.createElement('input'); 
            bgInput.type = 'color'; 
            bgInput.style.display = 'none'; 
            bgInput.value = bgColor;
            
            bgInput.addEventListener('change', function(e) { 
                t.color = e.target.value; 
                GM_setValue('notepad_tabs', notepadTabs); 
                renderTabs(); 
                pushToDesktop(); // Sync update
                renderLiveDashboard();
            });
            bgBtn.addEventListener('click', function(e) { 
                e.stopPropagation(); 
                bgInput.click(); 
            });

            const txtBtn = document.createElement('span'); 
            txtBtn.textContent = '🅰️'; 
            txtBtn.title = 'Text Color'; 
            txtBtn.style.cursor = 'pointer';
            txtBtn.style.marginLeft = '6px';
            txtBtn.style.fontSize = '12px';
            
            const txtInput = document.createElement('input'); 
            txtInput.type = 'color'; 
            txtInput.style.display = 'none'; 
            txtInput.value = txtColor;
            
            txtInput.addEventListener('change', function(e) { 
                t.textColor = e.target.value; 
                GM_setValue('notepad_tabs', notepadTabs); 
                renderTabs(); 
                pushToDesktop(); // Sync update
                renderLiveDashboard();
            });
            txtBtn.addEventListener('click', function(e) { 
                e.stopPropagation(); 
                txtInput.click(); 
            });
            
            cardControls.appendChild(bgBtn);
            cardControls.appendChild(bgInput);
            cardControls.appendChild(txtBtn);
            cardControls.appendChild(txtInput);
            
            cardHeader.appendChild(cardTitle);
            cardHeader.appendChild(cardControls);
            
            const cardBody = document.createElement('div');
            cardBody.className = 'gcs-dash-card-body';
            
            if (t.type === 'image') {
                const imgContainer = document.createElement('div');
                imgContainer.className = 'gcs-dash-image-container';
                const img = document.createElement('img');
                img.src = t.text;
                img.className = 'gcs-dash-image';
                imgContainer.appendChild(img);
                cardBody.appendChild(imgContainer);
            } else {
                const ta = document.createElement('textarea');
                ta.className = 'gcs-dash-textarea';
                ta.style.color = txtColor;
                ta.value = t.text;
                
                // Live sync text back to the main widget
                ta.addEventListener('input', function(e) {
                    t.text = e.target.value;
                    GM_setValue('notepad_tabs', notepadTabs);
                    renderTabs();
                    pushToDesktop(); // Sync update
                });
                cardBody.appendChild(ta);
            }
            
            card.appendChild(cardHeader);
            card.appendChild(cardBody);
            grid.appendChild(card);
        });
        
        dashboardOverlay.appendChild(grid);
    }

    // ==========================================
    // 16. STATIC DASHBOARD GENERATION
    // ==========================================

    function generateStaticDashboard() {
        let noteHtmlString = '';
        
        notepadTabs.forEach(function(t, i) {
            let bgColor = '#fffbe6';
            if (t.color !== '') {
                bgColor = t.color;
            } else if (isDarkMode === true) {
                bgColor = '#3b3721';
            }

            let txtColor = '#333';
            if (t.textColor !== '') {
                txtColor = t.textColor;
            } else if (isDarkMode === true) {
                txtColor = '#e0e0e0';
            }

            let icon = '📝';
            if (t.type === 'image') {
                icon = '🖼️';
            }
            
            let contentHtml = '';
            if (t.type === 'image') {
                contentHtml = `<img src="${t.text}" style="max-width:100%;max-height:100%;">`;
            } else {
                contentHtml = t.text.replace(/</g, '&lt;');
            }

            noteHtmlString = noteHtmlString + `
                <div class="note" style="background-color:${bgColor}; color:${txtColor};" onclick="openModal(${i})">
                    <h3>${icon} ${t.title}</h3>
                    <div class="note-content">${contentHtml}</div>
                </div>
            `;
        });

        let bgBodyColor = '#f0f0f0';
        let txtBodyColor = '#333';
        let borderBodyColor = '#ccc';
        let modalBgColor = '#fff';

        if (isDarkMode === true) {
            bgBodyColor = '#1e1e1e';
            txtBodyColor = '#eee';
            borderBodyColor = '#444';
            modalBgColor = '#2b2b2b';
        }

        const html = `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="utf-8">
                    <title>${settings.widgetTitle} - Export</title>
                    <style>
                        body { 
                            font-family: Arial; 
                            background: ${bgBodyColor}; 
                            color: ${txtBodyColor}; 
                            padding: 20px; 
                        } 
                        .grid { 
                            display: flex; 
                            flex-wrap: wrap; 
                            gap: 20px; 
                        } 
                        .note { 
                            resize: both; 
                            overflow: hidden; 
                            min-width: 200px; 
                            min-height: 200px; 
                            padding: 10px; 
                            border-radius: 8px; 
                            box-shadow: 0 4px 8px rgba(0,0,0,0.3); 
                            position: relative; 
                            cursor: pointer; 
                            transition: transform 0.1s; 
                            border: 1px solid ${borderBodyColor}; 
                        } 
                        .note:hover { 
                            transform: scale(1.02); 
                        } 
                        .note h3 { 
                            margin: 0 0 10px 0; 
                            font-size: 14px; 
                            border-bottom: 1px solid rgba(0,0,0,0.1); 
                            padding-bottom: 5px; 
                            pointer-events: none;
                        } 
                        .note-content { 
                            white-space: pre-wrap; 
                            font-size: 13px; 
                            height: calc(100% - 30px); 
                            overflow: hidden; 
                            pointer-events: none; 
                        } 
                        #overlay { 
                            display: none; 
                            position: fixed; 
                            top: 0; 
                            left: 0; 
                            width: 100%; 
                            height: 100%; 
                            background: rgba(0,0,0,0.7); 
                            z-index: 1000; 
                            justify-content: center; 
                            align-items: center; 
                        } 
                        .modal { 
                            background: ${modalBgColor}; 
                            width: 80%; 
                            max-width: 800px; 
                            max-height: 80vh; 
                            padding: 20px; 
                            border-radius: 8px; 
                            display: flex; 
                            flex-direction: column; 
                        } 
                        .modal-header { 
                            display: flex; 
                            justify-content: space-between; 
                            margin-bottom: 15px; 
                        } 
                        .modal-body { 
                            overflow-y: auto; 
                            flex-grow: 1; 
                            padding: 10px; 
                            border: 1px solid #ccc; 
                            border-radius: 4px; 
                            white-space: pre-wrap; 
                        } 
                        button { 
                            cursor: pointer; 
                            padding: 8px 16px; 
                            margin-left: 10px; 
                            border: none; 
                            border-radius: 4px; 
                            background: #007bff; 
                            color: white; 
                        } 
                        button.close { 
                            background: #dc3545; 
                        }
                    </style>
                </head>
                <body>
                    <h2>${settings.widgetTitle} - Static Export</h2>
                    <p><i>Note: This is a static export. Edits here will not sync back to the main extension.</i></p>
                    <div class="grid">${noteHtmlString}</div>
                    <div id="overlay" onclick="if(event.target===this) closeModal()">
                        <div class="modal">
                            <div class="modal-header">
                                <h2 id="m-title" style="margin:0;"></h2>
                                <div>
                                    <button onclick="copyContent()">Copy</button>
                                    <button class="close" onclick="closeModal()">Close</button>
                                </div>
                            </div>
                            <div class="modal-body" id="m-body"></div>
                        </div>
                    </div>
                    <script>
                        const tabs = ${JSON.stringify(notepadTabs)}; 
                        let activeIdx = 0; 
                        
                        function openModal(idx) { 
                            activeIdx = idx; 
                            const t = tabs[idx]; 
                            document.getElementById('m-title').textContent = t.title; 
                            
                            const body = document.getElementById('m-body'); 
                            
                            if (t.color !== '') {
                                body.style.backgroundColor = t.color;
                            } else {
                                body.style.backgroundColor = '';
                            }
                            
                            if (t.textColor !== '') {
                                body.style.color = t.textColor;
                            } else {
                                body.style.color = '';
                            }
                            
                            if (t.type === 'image') {
                                body.innerHTML = '<img src="' + t.text + '" style="max-width:100%;">';
                            } else {
                                body.innerHTML = t.text.replace(/</g,'&lt;');
                            }
                            
                            document.getElementById('overlay').style.display = 'flex'; 
                        } 
                        
                        function closeModal() { 
                            document.getElementById('overlay').style.display = 'none'; 
                        } 
                        
                        function copyContent() { 
                            const t = tabs[activeIdx]; 
                            if (t.type === 'image') {
                                fetch(t.text)
                                    .then(function(r) { return r.blob(); })
                                    .then(function(b) { 
                                        const item = new ClipboardItem({[b.type]: b});
                                        return navigator.clipboard.write([item]); 
                                    })
                                    .then(function() { alert('Copied!'); })
                                    .catch(function() { alert('CORS Error. Image cross-origin blocked by browser.'); }); 
                            } else {
                                navigator.clipboard.writeText(t.text)
                                    .then(function() { alert('Copied!'); }); 
                            }
                        }
                    </script>
                </body>
            </html>
        `;
        
        const blob = new Blob([html], {type: 'text/html;charset=utf-8'});
        window.open(URL.createObjectURL(blob), '_blank');
    }

    // ==========================================
    // 17. RENDERING LOGIC (TABS)
    // ==========================================

    function renameTab(titleSpan, tabId) {
        if (titleSpan.parentNode.className === 'gcs-tab-edit-group') {
            return;
        }
        const currentTitle = titleSpan.textContent.replace(/^[📝🖼️]\s*/, '');
        const input = document.createElement('input'); 
        input.type = 'text'; 
        input.value = currentTitle; 
        input.style.fontSize = '11px';
        input.style.width = '80px';
        input.style.padding = '1px 3px';
        
        const group = document.createElement('div'); 
        group.className = 'gcs-tab-edit-group'; 
        group.style.display = 'flex';
        group.style.alignItems = 'center';
        
        titleSpan.style.display = 'none'; 
        titleSpan.parentNode.insertBefore(group, titleSpan); 
        group.appendChild(input); 
        input.focus();

        const commitChange = function() { 
            let newTitle = input.value.trim();
            if (newTitle === '') {
                newTitle = 'Untitled';
            }
            
            const foundTab = notepadTabs.find(function(t) {
                return t.id === tabId;
            });
            if (foundTab !== undefined) {
                foundTab.title = newTitle; 
            }
            GM_setValue('notepad_tabs', notepadTabs); 
            pushToDesktop(); // Sync update
            
            group.remove(); 
            titleSpan.style.display = 'inline'; 
            
            let iconPrefix = '📝 ';
            if (titleSpan.parentNode.getAttribute('data-type') === 'image') {
                iconPrefix = '🖼️ ';
            }
            titleSpan.textContent = iconPrefix + newTitle; 
            titleSpan.title = "Double-click to rename"; 
            renderTabs(); 
            
            if (isDashboardOpen === true) {
                renderLiveDashboard();
            }
        };
        
        input.addEventListener('keydown', function(e) { 
            if (e.key === 'Enter') {
                commitChange(); 
            }
            if (e.key === 'Escape') { 
                group.remove(); 
                titleSpan.style.display = 'inline'; 
            } 
        });
        input.addEventListener('blur', commitChange);
    }

    function renderTabs() {
        tabBar.innerHTML = ''; 
        let activeTab = notepadTabs.find(function(t) {
            return t.id === activeTabId;
        });
        
        if (activeTab === undefined) {
            activeTab = notepadTabs[0];
        }
        
        if (activeTab.color !== '') {
            notepadWrapper.style.backgroundColor = activeTab.color;
        } else {
            notepadWrapper.style.backgroundColor = 'var(--gcs-note-bg)';
        }
        
        if (activeTab.textColor !== '') {
            notepadInput.style.color = activeTab.textColor;
        } else {
            notepadInput.style.color = 'var(--gcs-note-text)';
        }
        
        if (activeTab.type === 'image') { 
            notepadInput.style.display = 'none'; 
            imageViewer.style.display = 'flex'; 
            imageViewer.innerHTML = `<img src="${activeTab.text}" style="max-width:100%;max-height:80%;object-fit:contain;margin-bottom:12px;border-radius:4px;">`; 
            
            const cp = document.createElement('button'); 
            cp.textContent = 'Copy Image'; 
            cp.style.cursor = 'pointer';
            cp.style.padding = '6px 12px';
            cp.style.border = '1px solid var(--gcs-btn-border)';
            cp.style.backgroundColor = 'var(--gcs-btn-bg)';
            cp.style.borderRadius = '4px';
            cp.style.fontSize = '12px';
            cp.style.color = 'var(--gcs-btn-text)';
            
            cp.addEventListener('click', function() { 
                copyImageToClipboard(activeTab.text); 
                const oldText = cp.textContent; 
                cp.textContent = 'Copied!'; 
                cp.style.backgroundColor = 'var(--gcs-success-bg)'; 
                cp.style.color = 'var(--gcs-btn-text)'; 
                setTimeout(function() { 
                    cp.textContent = oldText; 
                    cp.style.backgroundColor = 'var(--gcs-btn-bg)'; 
                }, 1000); 
            }); 
            imageViewer.appendChild(cp); 
        } else { 
            notepadInput.style.display = 'block'; 
            imageViewer.style.display = 'none'; 
            notepadInput.value = activeTab.text; 
        }
        
        notepadTabs.forEach(function(t) { 
            const isActive = (t.id === activeTabId); 
            const tab = document.createElement('div'); 
            tab.className = 'gcs-tab'; 
            tab.setAttribute('data-type', t.type); 
            
            // Allow tabs to accept drops
            tab.addEventListener('dragover', handleTabDragOver);
            tab.addEventListener('drop', function(e) {
                handleTabDrop(e, t.id);
            });
            
            let bgColor = 'rgba(0,0,0,0.05)';
            if (isActive === true) {
                if (t.color !== '') {
                    bgColor = t.color;
                } else {
                    bgColor = 'var(--gcs-note-bg)';
                }
            }
            
            tab.style.display = 'flex';
            tab.style.alignItems = 'center';
            tab.style.padding = '4px 8px';
            tab.style.backgroundColor = bgColor;
            tab.style.borderRight = '1px solid var(--gcs-note-border)';
            tab.style.userSelect = 'none';
            tab.style.cursor = 'default'; 
            
            if (isActive === true) {
                tab.style.opacity = '1';
                tab.style.fontWeight = 'bold';
            } else {
                tab.style.opacity = '0.7';
                tab.style.fontWeight = 'normal';
                
                // Allow non-active tabs to be clicked to activate
                tab.addEventListener('click', function() { 
                    activeTabId = t.id; 
                    GM_setValue('active_tab_id', activeTabId); 
                    renderTabs(); 
                }); 
            }
            
            const ts = document.createElement('span'); 
            ts.className = 'gcs-tab-title'; 
            
            // ONLY the title is draggable in the scratchpad now
            ts.draggable = true;
            ts.style.cursor = 'grab'; 
            ts.addEventListener('dragstart', function(e) {
                handleTabDragStart(e, t.id);
            });
            ts.addEventListener('dragend', handleTabDragEnd);
            
            let iconPrefix = '📝 ';
            if (t.type === 'image') {
                iconPrefix = '🖼️ ';
            }
            ts.textContent = iconPrefix + t.title; 
            ts.title = "Double-click to rename. Drag to reorder."; 
            
            ts.addEventListener('dblclick', function() { 
                renameTab(ts, t.id); 
            });
            
            if (isActive === true) { 
                const bgBtn = document.createElement('span'); 
                bgBtn.textContent = '🎨'; 
                bgBtn.title = 'Background Color'; 
                bgBtn.style.cursor = 'pointer';
                bgBtn.style.marginLeft = '6px';
                bgBtn.style.fontSize = '11px';
                
                const bgInput = document.createElement('input'); 
                bgInput.type = 'color'; 
                bgInput.style.display = 'none'; 
                
                if (t.color !== '') {
                    bgInput.value = t.color;
                } else if (isDarkMode === true) {
                    bgInput.value = '#3b3721';
                } else {
                    bgInput.value = '#fffbe6';
                }
                
                bgInput.addEventListener('change', function(e) { 
                    t.color = e.target.value; 
                    GM_setValue('notepad_tabs', notepadTabs); 
                    renderTabs(); 
                    pushToDesktop(); // Sync update
                    if (isDashboardOpen === true) renderLiveDashboard();
                });
                bgBtn.addEventListener('click', function(e) { 
                    e.stopPropagation(); 
                    bgInput.click(); 
                });

                const txtBtn = document.createElement('span'); 
                txtBtn.textContent = '🅰️'; 
                txtBtn.title = 'Text Color'; 
                txtBtn.style.cursor = 'pointer';
                txtBtn.style.marginLeft = '4px';
                txtBtn.style.fontSize = '11px';
                
                const txtInput = document.createElement('input'); 
                txtInput.type = 'color'; 
                txtInput.style.display = 'none'; 
                
                if (t.textColor !== '') {
                    txtInput.value = t.textColor;
                } else if (isDarkMode === true) {
                    txtInput.value = '#e0e0e0';
                } else {
                    txtInput.value = '#333333';
                }
                
                txtInput.addEventListener('change', function(e) { 
                    t.textColor = e.target.value; 
                    GM_setValue('notepad_tabs', notepadTabs); 
                    renderTabs(); 
                    pushToDesktop(); // Sync update
                    if (isDashboardOpen === true) renderLiveDashboard();
                });
                txtBtn.addEventListener('click', function(e) { 
                    e.stopPropagation(); 
                    txtInput.click(); 
                });

                tab.appendChild(ts); 
                tab.appendChild(bgBtn); 
                tab.appendChild(bgInput); 
                tab.appendChild(txtBtn); 
                tab.appendChild(txtInput);
                
                if (notepadTabs.length > 1) { 
                    const del = document.createElement('span'); 
                    del.textContent = '✖'; 
                    del.title = "Delete tab"; 
                    del.style.marginLeft = '6px';
                    del.style.fontSize = '9px';
                    del.style.cursor = 'pointer';
                    del.style.color = '#ff4444';
                    
                    del.addEventListener('click', function(e) { 
                        e.stopPropagation(); 
                        if (confirm(`Delete "${t.title}"?`) === true) { 
                            notepadTabs = notepadTabs.filter(function(x) {
                                return x.id !== t.id;
                            }); 
                            activeTabId = notepadTabs[0].id; 
                            GM_setValue('notepad_tabs', notepadTabs); 
                            GM_setValue('active_tab_id', activeTabId); 
                            renderTabs(); 
                            pushToDesktop(); // Sync update
                            if (isDashboardOpen === true) renderLiveDashboard();
                        } 
                    }); 
                    tab.appendChild(del); 
                }
            } else { 
                tab.appendChild(ts); 
            } 
            tabBar.appendChild(tab); 
        });
        
        const add = document.createElement('div'); 
        add.textContent = '+'; 
        add.title = "Add tab"; 
        add.style.padding = '4px 8px';
        add.style.cursor = 'pointer';
        add.style.color = 'var(--gcs-note-text)';
        add.style.fontSize = '12px';
        add.style.fontWeight = 'bold';
        
        add.addEventListener('click', function() { 
            const newId = Date.now(); 
            notepadTabs.push({ 
                id: newId, 
                title: `Note ${notepadTabs.length + 1}`, 
                text: '', 
                type: 'text', 
                color: '', 
                textColor: '' 
            }); 
            activeTabId = newId; 
            GM_setValue('notepad_tabs', notepadTabs); 
            GM_setValue('active_tab_id', activeTabId); 
            renderTabs(); 
            pushToDesktop(); // Sync update
            setTimeout(function() { 
                tabBar.scrollLeft = tabBar.scrollWidth; 
            }, 10); 
            if (isDashboardOpen === true) renderLiveDashboard();
        }); 
        tabBar.appendChild(add);
    }

    // ==========================================
    // 18. RENDERING LOGIC (LIST)
    // ==========================================

    function renderList() {
        listContainer.innerHTML = '';
        
        if (savedItems.length === 0) { 
            listContainer.innerHTML = `<div style="padding: 10px; color: var(--gcs-text); text-align: center; opacity: 0.6;">No items saved.<br>Hold ${settings.hotkey} and click text or images.</div>`; 
            return; 
        }
        
        savedItems.forEach(function(item, index) { 
            const row = document.createElement('div'); 
            let bottomBorder = 'none';
            if (index < savedItems.length - 1) {
                bottomBorder = '1px solid var(--gcs-row-border)';
            }
            
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.padding = '6px 0';
            row.style.borderBottom = bottomBorder;

            const cs = document.createElement('span'); 
            cs.className = 'cs'; 
            cs.style.whiteSpace = 'nowrap';
            cs.style.overflow = 'hidden';
            cs.style.textOverflow = 'ellipsis';
            cs.style.marginRight = '10px';
            cs.style.cursor = 'default';
            cs.style.color = 'var(--gcs-text)';
            cs.style.flexGrow = '1';
            cs.style.display = 'flex';
            cs.style.alignItems = 'center';

            if (item.type === 'image') { 
                const th = document.createElement('img'); 
                th.src = item.text; 
                th.style.height = '20px';
                th.style.width = '20px';
                th.style.objectFit = 'cover';
                th.style.borderRadius = '3px';
                th.style.marginRight = '6px';
                th.style.border = '1px solid var(--gcs-border)';
                
                cs.appendChild(th); 
                cs.appendChild(document.createTextNode(' Image Captured')); 
                cs.title = item.text;
            } else { 
                const words = item.text.split(/\s+/); 
                if (words.length > 3) {
                    cs.textContent = words.slice(0, 3).join(' ') + '...';
                } else {
                    cs.textContent = item.text;
                }
                cs.title = item.text;
            }

            const bg = document.createElement('div'); 
            bg.style.display = 'flex';
            bg.style.alignItems = 'center';

            const pb = document.createElement('button'); 
            pb.textContent = '←'; 
            pb.title = 'Push to Scratchpad'; 
            pb.style.cursor = 'pointer';
            pb.style.padding = '4px 6px';
            pb.style.border = 'none';
            pb.style.background = 'transparent';
            pb.style.fontSize = '14px';
            pb.style.fontWeight = 'bold';
            pb.style.color = 'var(--gcs-text)';
            pb.style.marginRight = '4px';
            
            pb.addEventListener('mouseover', function() { 
                pb.style.backgroundColor = 'var(--gcs-btn-bg)'; 
            }); 
            pb.addEventListener('mouseout', function() { 
                pb.style.backgroundColor = 'transparent'; 
            });
            
            pb.addEventListener('click', function() {
                if (item.type === 'image') { 
                    const newId = Date.now(); 
                    notepadTabs.push({ 
                        id: newId, 
                        title: `Image Note`, 
                        text: item.text, 
                        type: 'image', 
                        color: '', 
                        textColor: '' 
                    }); 
                    activeTabId = newId;
                } else {
                    let active = notepadTabs.find(function(t) {
                        return t.id === activeTabId;
                    }); 
                    if (active !== undefined && active.type === 'image') { 
                        const newId = Date.now(); 
                        active = { 
                            id: newId, 
                            title: `Note ${notepadTabs.length + 1}`, 
                            text: '', 
                            type: 'text', 
                            color: '', 
                            textColor: '' 
                        }; 
                        notepadTabs.push(active); 
                        activeTabId = active.id; 
                    }
                    if (active !== undefined) {
                        let prefix = '';
                        if (active.text !== '') {
                            prefix = '\n';
                        }
                        active.text = active.text + prefix + item.text;
                    }
                } 
                GM_setValue('notepad_tabs', notepadTabs); 
                GM_setValue('active_tab_id', activeTabId); 
                
                isNotepadOpen = true; 
                GM_setValue('is_notepad_open', true); 
                notepadWrapper.style.display = 'flex'; 
                noteToggleBtn.style.opacity = '1'; 
                renderTabs(); 
                pushToDesktop(); // Sync update
                
                if (isDashboardOpen === true) renderLiveDashboard();
                
                const oc = pb.style.color; 
                pb.style.color = '#4CAF50'; 
                setTimeout(function() { 
                    pb.style.color = oc; 
                }, 500);
            });

            const cb = document.createElement('button'); 
            cb.textContent = 'Copy'; 
            cb.style.cursor = 'pointer';
            cb.style.padding = '4px 8px';
            cb.style.border = '1px solid var(--gcs-btn-border)';
            cb.style.backgroundColor = 'var(--gcs-btn-bg)';
            cb.style.borderRadius = '4px';
            cb.style.fontSize = '11px';
            
            cb.addEventListener('click', function() { 
                if (item.type === 'image') {
                    copyImageToClipboard(item.text); 
                } else {
                    GM_setClipboard(item.text, 'text');
                }
                const ot = cb.textContent; 
                cb.textContent = 'Copied!'; 
                cb.style.backgroundColor = 'var(--gcs-success-bg)'; 
                cb.style.borderColor = 'var(--gcs-success-border)'; 
                
                setTimeout(function() { 
                    cb.textContent = ot; 
                    cb.style.backgroundColor = 'var(--gcs-btn-bg)'; 
                    cb.style.borderColor = 'var(--gcs-btn-border)'; 
                }, 1000);
            });

            const del = document.createElement('button'); 
            del.textContent = '✖'; 
            del.title = 'Delete item'; 
            del.style.cursor = 'pointer';
            del.style.padding = '4px 6px';
            del.style.border = 'none';
            del.style.background = 'transparent';
            del.style.color = '#ff6b6b';
            del.style.marginLeft = '4px';
            
            del.addEventListener('click', function() { 
                savedItems.splice(index, 1); 
                GM_setValue('saved_clicks', savedItems); 
                renderList(); 
                pushToDesktop(); // Sync update
            });
            
            bg.appendChild(pb); 
            bg.appendChild(cb); 
            bg.appendChild(del); 
            
            row.appendChild(cs); 
            row.appendChild(bg); 
            
            listContainer.appendChild(row); 
        });
    }

    // ==========================================
    // 19. ACTION BUTTON EVENTS
    // ==========================================

    settingsBtn.addEventListener('click', function() { 
        isSettingsOpen = !isSettingsOpen; 
        if (isSettingsOpen === true && isMinimized === false) {
            settingsPanel.style.display = 'flex';
        } else {
            settingsPanel.style.display = 'none';
        }
        
        if (isSettingsOpen === true) {
            settingsBtn.style.opacity = '1';
        } else {
            settingsBtn.style.opacity = '0.5';
        }
    });
    
    noteToggleBtn.addEventListener('click', function() { 
        isNotepadOpen = !isNotepadOpen; 
        GM_setValue('is_notepad_open', isNotepadOpen); 
        
        if (isNotepadOpen === true && isMinimized === false) {
            notepadWrapper.style.display = 'flex';
        } else {
            notepadWrapper.style.display = 'none';
        }
        
        if (isNotepadOpen === true) {
            noteToggleBtn.style.opacity = '1';
        } else {
            noteToggleBtn.style.opacity = '0.4';
        }
    });
    
    magnetBtn.addEventListener('click', function() { 
        isCoupled = !isCoupled; 
        GM_setValue('is_coupled', isCoupled); 
        
        if (isCoupled === true) {
            magnetBtn.style.opacity = '1';
        } else {
            magnetBtn.style.opacity = '0.4';
        }
    });
    
    resetBtn.addEventListener('click', function() { 
        resetBtn.style.transform = 'rotate(180deg)'; 
        setTimeout(function() { 
            resetBtn.style.transform = 'rotate(0deg)'; 
        }, 300);
        
        const cfg = GM_getValue('default_gcs_config');
        
        if (cfg !== undefined && cfg.mainSize !== undefined && cfg.mainSize.width !== undefined) { 
            mainWidget.style.left = cfg.mainPos.left; 
            mainWidget.style.top = cfg.mainPos.top;
            mainWidget.style.right = 'auto'; 
            mainWidget.style.bottom = 'auto';
            mainWidget.style.width = cfg.mainSize.width; 
            
            if (isMinimized === true) {
                mainWidget.style.height = 'auto';
            } else {
                mainWidget.style.height = cfg.mainSize.height;
            }
            
            notepadWrapper.style.left = cfg.notePos.left; 
            notepadWrapper.style.top = cfg.notePos.top;
            notepadWrapper.style.right = 'auto'; 
            notepadWrapper.style.bottom = 'auto';
            notepadWrapper.style.width = cfg.noteSize.width; 
            notepadWrapper.style.height = cfg.noteSize.height;
            
            settings.fontSize = cfg.fontSize; 
            GM_setValue('gcs_settings', settings); 
            fsInput.value = parseInt(settings.fontSize, 10);
            styleBlock.textContent = styleBlock.textContent.replace(/--gcs-font-size: \d+px;/g, `--gcs-font-size: ${settings.fontSize};`);
            
            isDarkMode = cfg.darkMode; 
            GM_setValue('is_dark_mode', isDarkMode); 
            if (isDarkMode === true) {
                document.documentElement.classList.add('gcs-dark-mode');
            } else {
                document.documentElement.classList.remove('gcs-dark-mode');
            }
            darkModeCb.checked = isDarkMode;
            
        } else { 
            mainWidget.style.left = 'auto'; 
            mainWidget.style.top = 'auto'; 
            mainWidget.style.right = defaultMainPos.right; 
            mainWidget.style.bottom = defaultMainPos.bottom;
            mainWidget.style.width = defaultMainSize.width; 
            
            if (isMinimized === true) {
                mainWidget.style.height = 'auto';
            } else {
                mainWidget.style.height = defaultMainSize.height;
            }
            
            notepadWrapper.style.left = 'auto'; 
            notepadWrapper.style.top = 'auto'; 
            notepadWrapper.style.right = defaultNotePos.right; 
            notepadWrapper.style.bottom = defaultNotePos.bottom;
            notepadWrapper.style.width = defaultNoteSize.width; 
            notepadWrapper.style.height = defaultNoteSize.height;
            
            settings.fontSize = '13px'; 
            GM_setValue('gcs_settings', settings); 
            fsInput.value = 13;
            styleBlock.textContent = styleBlock.textContent.replace(/--gcs-font-size: \d+px;/g, `--gcs-font-size: ${settings.fontSize};`);
            
            isDarkMode = true; 
            GM_setValue('is_dark_mode', isDarkMode); 
            document.documentElement.classList.add('gcs-dark-mode'); 
            darkModeCb.checked = isDarkMode;
        } 
        
        isCoupled = true; 
        GM_setValue('is_coupled', true); 
        magnetBtn.style.opacity = '1'; 
        savePosSize();
    });

    toggleBtn.addEventListener('click', function() { 
        isMinimized = !isMinimized; 
        GM_setValue('is_minimized', isMinimized);
        
        if (isMinimized === true) {
            settingsPanel.style.display = 'none'; 
            listContainer.style.display = 'none'; 
            listActionsRow.style.display = 'none';
            toggleBtn.textContent = '+';
            
            mainWidget.style.height = 'auto'; 
            mainWidget.style.minHeight = '0px'; 
            mainWidget.style.resize = 'none'; 
            notepadWrapper.style.display = 'none'; 
            
            settingsBtn.style.display = 'none';
            noteToggleBtn.style.display = 'none';
            magnetBtn.style.display = 'none';
            resetBtn.style.display = 'none';
        } else {
            if (isSettingsOpen === true) {
                settingsPanel.style.display = 'flex';
            } else {
                settingsPanel.style.display = 'none';
            }
            
            listContainer.style.display = 'block'; 
            listActionsRow.style.display = 'flex'; 
            toggleBtn.textContent = '−';
            
            mainWidget.style.height = mainSize.height; 
            mainWidget.style.minHeight = '150px'; 
            mainWidget.style.resize = 'both'; 
            
            if (isNotepadOpen === true) {
                notepadWrapper.style.display = 'flex'; 
            }
            
            settingsBtn.style.display = '';
            noteToggleBtn.style.display = '';
            magnetBtn.style.display = '';
            resetBtn.style.display = '';
        }
    });

    // ==========================================
    // 20. INITIALIZATION CALLS
    // ==========================================

    pullFromDesktop(); // Pull on initial load
    renderList(); 
    renderTabs();
    
    // Pull from desktop when user switches back to this browser tab
    window.addEventListener('focus', function() { 
        pullFromDesktop();
    });

})();

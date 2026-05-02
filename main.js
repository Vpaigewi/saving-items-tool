// Import the Electron framework
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const globalShortcut = electron.globalShortcut;
const clipboard = electron.clipboard;

// Import the Tray and Menu modules for background running
const Tray = electron.Tray;
const Menu = electron.Menu;
const nativeImage = electron.nativeImage;

// Import the file system and path modules to save our data
const fs = require('fs');
const path = require('path');

// Import the Express and CORS modules for our local sync server
const express = require('express');
const cors = require('cors');

// Define where the app will save its permanent data
const dataPath = path.join(app.getPath('userData'), 'gcs_data.json');

// Create the data file if it doesn't exist yet
if (fs.existsSync(dataPath) === false) {
    let emptyData = {
        savedItems: [],
        notepadTabs: [],
        settings: {
            hotkey: '`'
        }
    };
    let emptyDataString = JSON.stringify(emptyData);
    fs.writeFileSync(dataPath, emptyDataString);
}

// --- HOTKEY & CLIPBOARD MANAGEMENT ENGINE ---

// This flag tracks if the browser currently has focus
let isHotkeyPausedByBrowser = false;

// This function forces the OS to read the clipboard and save it
function captureOSClipboard() {
    let currentText = clipboard.readText();
    
    if (currentText !== '') {
        // Load the existing database
        let rawData = fs.readFileSync(dataPath, 'utf8');
        let database = JSON.parse(rawData);
        
        // --- ANTI-DUPLICATE FAILSAFE ---
        if (database.savedItems.length > 0 && database.savedItems[0].text === currentText) {
            return; 
        }
        
        // Create a new item object
        let newItem = {
            type: 'text',
            text: currentText
        };
        
        // Add it to the top of the saved items list
        database.savedItems.unshift(newItem);
        
        // Ensure we respect the maxItems limit
        let maxItems = 10;
        if (database.settings !== undefined && database.settings.maxItems !== undefined) {
            maxItems = database.settings.maxItems;
        }
        if (database.savedItems.length > maxItems) {
            database.savedItems = database.savedItems.slice(0, maxItems);
        }
        
        // Save it back to the hard drive
        let updatedDataString = JSON.stringify(database);
        fs.writeFileSync(dataPath, updatedDataString);
        
        // Tell the desktop UI to refresh if it happens to be visible
        if (mainWindow !== null) {
            mainWindow.webContents.send('data-updated');
        }
    }
}

// This function registers the hotkey with the Operating System
function registerGlobalHotkey() {
    globalShortcut.unregisterAll();
    
    if (isHotkeyPausedByBrowser === true) {
        return;
    }
    
    let rawData = fs.readFileSync(dataPath, 'utf8');
    let database = JSON.parse(rawData);
    
    let currentHotkey = '`';
    if (database.settings !== undefined) {
        if (database.settings.hotkey !== undefined) {
            currentHotkey = database.settings.hotkey;
        }
    }
    
    globalShortcut.register(currentHotkey, function() {
        captureOSClipboard();
    });
}


// --- LOCAL SYNC SERVER ---

const server = express();
server.use(cors());
server.use(express.json());

server.get('/sync', function(req, res) {
    let rawData = fs.readFileSync(dataPath, 'utf8');
    let parsedData = JSON.parse(rawData);
    res.json(parsedData);
});

server.post('/sync', function(req, res) {
    let newDataString = JSON.stringify(req.body);
    fs.writeFileSync(dataPath, newDataString);
    
    registerGlobalHotkey();
    
    if (mainWindow !== null) {
        mainWindow.webContents.send('data-updated');
    }
    
    res.json({ success: true });
});

server.post('/pause-hotkey', function(req, res) {
    isHotkeyPausedByBrowser = true;
    registerGlobalHotkey(); 
    res.json({ status: 'paused' });
});

server.post('/resume-hotkey', function(req, res) {
    isHotkeyPausedByBrowser = false;
    registerGlobalHotkey(); 
    res.json({ status: 'resumed' });
});

server.post('/capture-clipboard', function(req, res) {
    captureOSClipboard();
    res.json({ status: 'captured' });
});

server.listen(9876, function() {
    console.log('Local Sync Server is running on http://localhost:9876');
});


// --- ELECTRON WINDOW & TRAY MANAGEMENT ---

let mainWindow = null;
let tray = null;

// This tells the app if we actually want to quit, or just hide to the tray
let isQuitting = false;

function createWindow() {
    // Define the path to your new icon file
    const iconPath = path.join(__dirname, 'icon.png');
    
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        icon: iconPath, // This sets the icon in the top left of the window and taskbar
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    // Intercept the close button (the red X)
    mainWindow.on('close', function(event) {
        if (isQuitting === false) {
            // If we aren't explicitly quitting, stop the window from dying
            event.preventDefault();
            // Just hide it in the background instead
            mainWindow.hide();
        }
    });
}

// When Electron has finished starting up...
app.whenReady().then(function() {
    createWindow();
    registerGlobalHotkey();

  // --- SYSTEM TRAY SETUP ---
    
    const iconPath = path.join(__dirname, 'icon.png');
    let trayIcon;
    
    if (fs.existsSync(iconPath) === true) {
        // Load the raw image
        let rawIcon = nativeImage.createFromPath(iconPath);
        // Force Electron to perfectly resize it for the Windows Tray before rendering
        trayIcon = rawIcon.resize({ width: 24, height: 24 });
    } else {
        trayIcon = nativeImage.createEmpty();
    }
    
    tray = new Tray(trayIcon);
    
    // Failsafe: Use a blank icon to prevent crashing if the user hasn't downloaded icon.png yet
    if (fs.existsSync(iconPath) === true) {
        trayIcon = nativeImage.createFromPath(iconPath);
    } else {
        trayIcon = nativeImage.createEmpty();
    }
    
    tray = new Tray(trayIcon);

    // Create the right-click menu for the tray icon
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'Show Dashboard', 
            click: function() { 
                mainWindow.show(); 
            } 
        },
        { type: 'separator' },
        { 
            label: 'Quit', 
            click: function() { 
                // Set the flag so the window knows it's allowed to die
                isQuitting = true; 
                app.quit(); 
            } 
        }
    ]);

    tray.setToolTip('Backtick Clipboard Saver');
    tray.setContextMenu(contextMenu);

    // Left-clicking the tray icon toggles the app open and closed
    tray.on('click', function() {
        if (mainWindow.isVisible() === true) {
            mainWindow.hide();
        } else {
            mainWindow.show();
        }
    });
});

// We removed the old app.on('window-all-closed') event here. 
// By removing it, the app stays alive in the background indefinitely!

// Unregister hotkeys when the app finally closes
app.on('will-quit', function() {
    globalShortcut.unregisterAll();
});
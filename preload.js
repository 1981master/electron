const { contextBridge, ipcRenderer } = require('electron');

// Listen for clear command from main process (ONLY on app quit)
ipcRenderer.on('clear-local-storage', () => {
    console.log('Clearing JWT storage on app quit');

    try {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        console.log('JWT storage cleared successfully');
    } catch (err) {
        console.error('Error clearing JWT storage:', err);
    }
});

// Optional: expose API if needed
contextBridge.exposeInMainWorld('electronAPI', {
    onClearLocalStorage: (callback) => ipcRenderer.on('clear-local-storage', callback)
});
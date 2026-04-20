const { app, BrowserWindow, dialog, session } = require('electron')
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

let mainWindow
let backendProcess

const BACKEND_PORT = 8080
const USE_H2 = true
const dbFolder = path.join(os.homedir(), 'DeffufaData')

const isDev = !app.isPackaged

// Backend JAR path
const backendJar = isDev
    ? path.join(__dirname, 'backend', 'deffufa-0.0.1-SNAPSHOT.jar')
    : path.join(process.resourcesPath, 'backend', 'deffufa-0.0.1-SNAPSHOT.jar')

// Java path (bundled JRE)
const javaPath = isDev
    ? path.join(
          __dirname,
          'backend',
          'jre',
          'bin',
          process.platform === 'win32' ? 'java.exe' : 'java',
      )
    : path.join(
          process.resourcesPath,
          'backend',
          'jre',
          'bin',
          process.platform === 'win32' ? 'java.exe' : 'java',
      )

// ----------------------------
// Logging helper
const logFile = path.join(os.homedir(), 'deffufa-backend.log')
function log(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`
    console.log(line)
    fs.appendFileSync(logFile, line)
}

// ----------------------------
// Kill orphan H2 process
function killOrphanH2() {
    if (!USE_H2) return
    try {
        if (process.platform === 'win32') {
            // optional Windows handling
        } else {
            const result = execSync(
                `lsof ${path.join(dbFolder, 'deffufa.mv.db')} || true`,
            ).toString()
            result
                .split('\n')
                .slice(1)
                .forEach((line) => {
                    const parts = line.trim().split(/\s+/)
                    const pid = parseInt(parts[1], 10)
                    if (!isNaN(pid)) {
                        log(`Killing orphan H2 process PID=${pid}`)
                        try {
                            process.kill(pid)
                        } catch {}
                    }
                })
        }
    } catch (err) {
        log(`No orphan H2 processes detected or failed: ${err}`)
    }
}

// ----------------------------
// Cleanup backend
function cleanupBackend() {
    if (backendProcess && !backendProcess.killed) {
        try {
            backendProcess.kill('SIGTERM')
            log(`Backend process ${backendProcess.pid} killed`)
        } catch (err) {
            log(`Failed to kill backend process: ${err}`)
        }
    }
}

// ----------------------------
// Wait for backend ready
function waitForBackendReady(port, callback, retries = 30, intervalMs = 1000) {
    let attempts = 0
    const check = () => {
        const req = http.request(
            { method: 'GET', hostname: 'localhost', port, path: '/' },
            (res) => {
                log(`Backend ready (status ${res.statusCode})`)
                callback()
            },
        )
        req.on('error', () => {
            attempts++
            if (attempts < retries) setTimeout(check, intervalMs)
            else {
                dialog.showErrorBox(
                    'Error',
                    `Backend failed to start. Check log file at ${logFile}`,
                )
                app.quit()
            }
        })
        req.end()
    }
    check()
}

// ----------------------------
// Start Spring Boot backend
function startBackend(jarPath, dbFolder, callback) {
    if (!fs.existsSync(dbFolder)) {
        log(`Creating DB folder: ${dbFolder}`)
        fs.mkdirSync(dbFolder, { recursive: true })
    }

    killOrphanH2()

    const jdbcUrl = USE_H2
        ? `jdbc:h2:file:${path.join(dbFolder, 'deffufa')};AUTO_SERVER=TRUE;DB_CLOSE_ON_EXIT=TRUE`
        : `jdbc:mysql://localhost:3306/deffufa`

    let javaCmd = javaPath
    if (!fs.existsSync(javaCmd)) {
        log('Bundled Java not found, falling back to system Java')
        javaCmd = 'java'
    } else {
        log(`Using bundled Java at: ${javaCmd}`)
    }

    if (!javaCmd) {
        log('No suitable Java found. Backend will not start.')
        createWindow()
        return
    }

    try {
        backendProcess = spawn(
            javaCmd,
            [`-Dspring.datasource.url=${jdbcUrl}`, '-jar', jarPath],
            { cwd: path.dirname(jarPath) },
        )
    } catch (err) {
        log(`Failed to start backend process: ${err}`)
        dialog.showErrorBox('Startup Error', 'Failed to start backend process.')
        app.quit()
        return
    }

    backendProcess.stdout.on('data', (data) =>
        log(`Backend stdout: ${data.toString().trim()}`),
    )
    backendProcess.stderr.on('data', (data) =>
        log(`Backend stderr: ${data.toString().trim()}`),
    )
    backendProcess.on('close', (code) =>
        log(`Backend exited with code ${code}`),
    )

    waitForBackendReady(BACKEND_PORT, callback)
}

// ----------------------------
// Create Electron window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    })

    const indexPath = isDev
        ? path.join(__dirname, 'build', 'index.html') // dev: build inside electron folder
        : path.join(process.resourcesPath, 'build', 'index.html') // packaged

    const startUrl = `file://${indexPath.replace(/\\/g, '/')}`
    mainWindow.loadURL(startUrl)

    mainWindow.on('closed', () => (mainWindow = null))
}

// ----------------------------
// App ready
app.whenReady().then(() => {
    if (!fs.existsSync(backendJar)) {
        dialog.showErrorBox('Error', `Backend JAR not found at: ${backendJar}`)
        app.quit()
        return
    }
    startBackend(backendJar, dbFolder, createWindow)
})

// ----------------------------
// BEFORE QUIT → clear frontend storage
app.on('before-quit', async () => {
    log('App before-quit → clearing storage')
    try {
        await session.defaultSession.clearStorageData({
            storages: ['localstorage', 'cookies', 'indexdb'],
        })
        if (mainWindow && mainWindow.webContents)
            mainWindow.webContents.send('clear-local-storage')
        log('Storage cleared successfully')
    } catch (err) {
        log(`Error clearing storage: ${err}`)
    }
})

// ----------------------------
// WILL QUIT → kill backend
app.on('will-quit', () => {
    log('App will-quit → shutting down backend')
    cleanupBackend()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ----------------------------
// Signals & exceptions
process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())
process.on('exit', () => {
    log('Process exit → cleanup backend')
    cleanupBackend()
})
process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err}`)
    app.quit()
})
